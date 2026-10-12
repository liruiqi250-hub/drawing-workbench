"""Windows directory notifications for DrawingWorkbench, without any scan.

One synchronous ReadDirectoryChangesW thread per root. Local buffers are 1 MiB;
UNC buffers are 64 KiB. Standard-library ctypes only; no administrator required.
stdout is UTF-8 NDJSON. Keep stdin open while watching; EOF cancels all I/O.
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import ntpath
import queue
import struct
import sys
import threading

LOCAL_BUFFER = 1024 * 1024
UNC_BUFFER = 64 * 1024
NOTIFY_FILTER = 0x01 | 0x02 | 0x08 | 0x10
ERROR_OPERATION_ABORTED = 995
ERROR_NOTIFY_ENUM_DIR = 1022
ERROR_INVALID_PARAMETER = 87
stopping = threading.Event()
messages: queue.Queue = queue.Queue(maxsize=512)
overflow_roots: set[str] = set()
overflow_lock = threading.Lock()
handles: dict[int, int] = {}
handles_lock = threading.Lock()


def emit(record: dict) -> None:
    """Never block notification readers on a slow Node stdout consumer."""
    try:
        messages.put_nowait(record)
    except queue.Full:
        with overflow_lock:
            overflow_roots.add(record.get("root", ""))


def writer() -> None:
    while not stopping.is_set() or not messages.empty():
        try:
            record = messages.get(timeout=0.2)
        except queue.Empty:
            record = None
        with overflow_lock:
            lost = tuple(overflow_roots)
            overflow_roots.clear()
        try:
            for root in lost:
                print(json.dumps({"type": "overflow", "root": root,
                                  "reason": "输出队列已满，需要核对索引"},
                                 ensure_ascii=False, separators=(",", ":")), flush=True)
            if record is not None:
                print(json.dumps(record, ensure_ascii=False, separators=(",", ":")), flush=True)
        except (BrokenPipeError, OSError):
            stopping.set()
            return


def normalized(p: str) -> str:
    return ntpath.normcase(ntpath.normpath(p))


class Scope:
    def __init__(self, settings: dict):
        roots = settings.get("roots")
        if not isinstance(roots, list) or not roots or len(roots) > 64:
            raise ValueError("监听设置需要 1 至 64 个根目录")
        self.roots = []
        seen = set()
        for root in roots:
            if not isinstance(root, str) or "\0" in root or not ntpath.isabs(root):
                raise ValueError("监听位置必须是完整 Windows 路径")
            key = normalized(root)
            if key not in seen:
                self.roots.append(root)
                seen.add(key)
        self.exclude_names = set()
        self.exclude_paths = []
        for item in settings.get("excludeDirs", []):
            if not isinstance(item, str) or not item.strip():
                continue
            if ntpath.isabs(item):
                self.exclude_paths.append(normalized(item))
            else:
                self.exclude_names.add(item.casefold())
        self.extensions = {str(x).lower() for x in settings.get("extensions", [])}

    def allowed(self, root: str, relative: str, action: int) -> str | None:
        # Windows notifications are relative. Strip an optional root separator,
        # but never let a drive-qualified filename escape its watched root.
        full = ntpath.normpath(ntpath.join(root, relative.lstrip("\\/")))
        key, root_key = normalized(full), normalized(root)
        try:
            if ntpath.commonpath([key, root_key]) != root_key:
                return None
        except ValueError:
            return None
        excluded = self.exclude_names.intersection(part.casefold() for part in key.split("\\"))
        if ".test-tmp" in excluded:
            # Match config.isExcluded: only an explicitly configured isolated root
            # inside .test-tmp overrides this name; a whole drive never does.
            for configured in self.roots:
                configured_key = normalized(configured)
                if ".test-tmp" in configured_key.split("\\"):
                    if key == configured_key or key.startswith(configured_key.rstrip("\\") + "\\"):
                        excluded.discard(".test-tmp")
                        break
        if excluded:
            return None
        if any(key == p or key.startswith(p.rstrip("\\") + "\\") for p in self.exclude_paths):
            return None
        # Add/remove/rename can represent a directory, including ones with a dot.
        # Modified events only need drawing files; directory births/moves have
        # their own FILE_NOTIFY_CHANGE_DIR_NAME notification.
        if action == 3 and ntpath.splitext(full)[1].lower() not in self.extensions:
            return None
        return full


def parse_changes(raw: bytes, root: str, scope: Scope) -> list[dict]:
    changes, offset = [], 0
    while offset < len(raw):
        if len(raw) - offset < 12:
            raise ValueError("目录通知数据头不完整")
        next_offset, action, name_bytes = struct.unpack_from("<3I", raw, offset)
        end = offset + 12 + name_bytes
        if name_bytes % 2 or end > len(raw) or action not in (1, 2, 3, 4, 5):
            raise ValueError("目录通知记录无效")
        relative = raw[offset + 12:end].decode("utf-16-le", errors="surrogatepass")
        full = scope.allowed(root, relative, action)
        if full is not None:
            changes.append({"action": action, "path": full})
        if not next_offset:
            break
        if next_offset < 12 + name_bytes or offset + next_offset >= len(raw):
            raise ValueError("目录通知偏移无效")
        offset += next_offset
    return changes


def initialize_api():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
        ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.ReadDirectoryChangesW.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
        wintypes.DWORD, wintypes.BOOL, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
        ctypes.c_void_p, ctypes.c_void_p]
    kernel.ReadDirectoryChangesW.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    kernel.CancelIoEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    kernel.CancelIoEx.restype = wintypes.BOOL
    kernel.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenThread.restype = wintypes.HANDLE
    kernel.CancelSynchronousIo.argtypes = [wintypes.HANDLE]
    kernel.CancelSynchronousIo.restype = wintypes.BOOL
    return kernel


def watch(root: str, scope: Scope, kernel) -> None:
    native_id = threading.get_native_id()
    buffer_size = UNC_BUFFER if root.startswith("\\\\") else LOCAL_BUFFER
    fallback_used = False
    retry_delay = 1.0
    invalid_handle = ctypes.c_void_p(-1).value
    while not stopping.is_set():
        handle = kernel.CreateFileW(root, 0x0001, 0x0001 | 0x0002 | 0x0004,
                                    None, 3, 0x02000000, None)
        if handle == invalid_handle:
            error = ctypes.get_last_error()
            emit({"type": "error", "root": root, "code": error,
                  "error": f"无法打开监听目录，WinError {error}"})
            stopping.wait(retry_delay)
            retry_delay = min(30.0, retry_delay * 2)
            continue
        with handles_lock:
            handles[native_id] = handle
        try:
            buffer = ctypes.create_string_buffer(buffer_size)
            emit({"type": "ready", "root": root, "bufferBytes": buffer_size})
            while not stopping.is_set():
                returned = wintypes.DWORD()
                ok = kernel.ReadDirectoryChangesW(handle, buffer, buffer_size, True,
                    NOTIFY_FILTER, ctypes.byref(returned), None, None)
                if not ok:
                    error = ctypes.get_last_error()
                    if stopping.is_set() and error in (ERROR_OPERATION_ABORTED, 6):
                        break
                    if error == ERROR_INVALID_PARAMETER and buffer_size > UNC_BUFFER and not fallback_used:
                        # A fresh handle is needed because Windows fixes its kernel
                        # notification buffer size on the first successful read.
                        fallback_used = True
                        buffer_size = UNC_BUFFER
                        break
                    if error == ERROR_NOTIFY_ENUM_DIR:
                        emit({"type": "overflow", "root": root})
                        continue
                    emit({"type": "error", "root": root, "code": error,
                          "error": f"目录监听中断，WinError {error}"})
                    stopping.wait(retry_delay)
                    retry_delay = min(30.0, retry_delay * 2)
                    break
                retry_delay = 1.0
                if returned.value == 0:
                    emit({"type": "overflow", "root": root})
                    continue
                try:
                    changes = parse_changes(ctypes.string_at(buffer, returned.value), root, scope)
                except (ValueError, UnicodeError) as error:
                    emit({"type": "overflow", "root": root, "reason": str(error)})
                    continue
                if changes:
                    emit({"type": "batch", "root": root, "changes": changes})
        finally:
            with handles_lock:
                handles.pop(native_id, None)
            kernel.CloseHandle(handle)


def cancel_workers(kernel) -> None:
    stopping.set()
    with handles_lock:
        active = tuple(handles.items())
    for thread_id, handle in active:
        # CancelSynchronousIo is needed for our synchronous per-root reader.
        thread_handle = kernel.OpenThread(0x0001, False, thread_id)
        if thread_handle:
            kernel.CancelSynchronousIo(thread_handle)
            kernel.CloseHandle(thread_handle)
        kernel.CancelIoEx(handle, None)


def main() -> int:
    parser = argparse.ArgumentParser(description="图纸工作台 Windows 大缓冲区目录监听")
    parser.add_argument("--config", required=True, help="包含 roots、excludeDirs、extensions 的 settings.json")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace", line_buffering=True)
    try:
        if sys.platform != "win32":
            raise ValueError("目录监听仅支持 Windows")
        with open(args.config, encoding="utf-8-sig") as source:
            settings = json.load(source)
        scope = Scope(settings)
        kernel = initialize_api()
    except Exception as error:
        print(json.dumps({"type": "error", "root": "", "error": str(error)}, ensure_ascii=False), flush=True)
        return 2
    output = threading.Thread(target=writer, name="watch-output", daemon=True)
    output.start()
    workers = [threading.Thread(target=watch, args=(root, scope, kernel),
                               name=f"watch-{i}", daemon=True)
               for i, root in enumerate(scope.roots)]
    for worker in workers:
        worker.start()
    try:
        while not stopping.is_set():
            if not sys.stdin.buffer.read(8192):
                break
    except (KeyboardInterrupt, OSError):
        pass
    finally:
        cancel_workers(kernel)
        for worker in workers:
            worker.join(timeout=1.0)
        output.join(timeout=1.0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
