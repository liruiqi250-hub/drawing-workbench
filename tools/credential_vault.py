"""Current-user Windows DPAPI bridge. Requests and responses use UTF-8 JSON."""

import base64
import ctypes
from ctypes import wintypes
import json
import sys


MAX_VALUE_LENGTH = 16384
CRYPTPROTECT_UI_FORBIDDEN = 0x1


class DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
    ]


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Invalid request")
        result[key] = value
    return result


def _dpapi(payload, decrypt):
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    blob_pointer = ctypes.POINTER(DATA_BLOB)

    crypt32.CryptProtectData.argtypes = [
        blob_pointer,
        wintypes.LPCWSTR,
        blob_pointer,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        blob_pointer,
    ]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    crypt32.CryptUnprotectData.argtypes = [
        blob_pointer,
        ctypes.POINTER(wintypes.LPWSTR),
        blob_pointer,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        blob_pointer,
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p

    input_buffer = ctypes.create_string_buffer(payload)
    input_blob = DATA_BLOB(
        len(payload), ctypes.cast(input_buffer, ctypes.POINTER(ctypes.c_ubyte))
    )
    output_blob = DATA_BLOB()
    try:
        function = (
            crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
        )
        succeeded = function(
            ctypes.byref(input_blob),
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            ctypes.byref(output_blob),
        )
        if not succeeded:
            raise OSError("DPAPI operation failed")
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        ctypes.memset(ctypes.addressof(input_buffer), 0, ctypes.sizeof(input_buffer))
        if output_blob.pbData:
            try:
                ctypes.memset(output_blob.pbData, 0, output_blob.cbData)
            finally:
                kernel32.LocalFree(ctypes.cast(output_blob.pbData, ctypes.c_void_p))


def _write_json(value):
    encoded = (json.dumps(value, ensure_ascii=False) + "\n").encode("utf-8")
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main():
    operation = "encrypt"
    try:
        request = json.loads(
            sys.stdin.buffer.read().decode("utf-8"), object_pairs_hook=_unique_object
        )
        if isinstance(request, dict) and request.get("operation") == "decrypt":
            operation = "decrypt"
        if len(sys.argv) != 1 or sys.platform != "win32":
            raise ValueError("Unsupported invocation")
        if not isinstance(request, dict) or set(request) != {"operation", "value"}:
            raise ValueError("Invalid request")
        if request["operation"] not in ("encrypt", "decrypt"):
            raise ValueError("Invalid operation")
        value = request["value"]
        if not isinstance(value, str) or len(value) > MAX_VALUE_LENGTH:
            raise ValueError("Invalid value")

        if operation == "encrypt":
            result = base64.b64encode(_dpapi(value.encode("utf-8"), False)).decode(
                "ascii"
            )
        else:
            encrypted = base64.b64decode(value.encode("ascii"), validate=True)
            result = _dpapi(encrypted, True).decode("utf-8")
        _write_json({"value": result})
        return 0
    except BaseException:
        message = (
            "本机密钥无法解密，请重新保存 API Key。"
            if operation == "decrypt"
            else "本机密钥加密失败。"
        )
        try:
            _write_json({"error": message})
        except BaseException:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
