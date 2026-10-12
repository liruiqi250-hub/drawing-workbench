"""只读定位文件：用 Windows Shell 返回值确认打开父目录并选中指定项。"""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import sys


def locate_file(value):
    source = Path(value)
    if not source.is_absolute():
        raise ValueError('请使用完整的图纸路径。')
    if not source.is_file():
        raise ValueError('图纸文件不存在或当前不可访问，请检查磁盘或共享连接后重试。')
    if os.name != 'nt':
        raise OSError('定位目录仅支持 Windows。')
    ole32 = ctypes.WinDLL('ole32')
    shell32 = ctypes.WinDLL('shell32')
    ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    ole32.CoInitializeEx.restype = ctypes.c_long
    ole32.CoUninitialize.argtypes = []
    ole32.CoUninitialize.restype = None
    ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    ole32.CoTaskMemFree.restype = None
    shell32.SHParseDisplayName.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    shell32.SHParseDisplayName.restype = ctypes.c_long
    shell32.SHOpenFolderAndSelectItems.argtypes = [ctypes.c_void_p, wintypes.UINT, ctypes.c_void_p, wintypes.DWORD]
    shell32.SHOpenFolderAndSelectItems.restype = ctypes.c_long
    initialized = False
    pidl = ctypes.c_void_p()
    try:
        hr = ole32.CoInitializeEx(None, 2)
        if hr not in (0, 1, -2147417850):
            raise OSError(f'Windows 定位服务初始化失败（0x{hr & 0xffffffff:08X}）。')
        initialized = hr in (0, 1)
        hr = shell32.SHParseDisplayName(str(source), None, ctypes.byref(pidl), 0, None)
        if hr < 0 or not pidl.value:
            raise OSError(f'Windows 无法读取这个文件的位置（0x{hr & 0xffffffff:08X}）。')
        # cidl=0: PIDL 指向完整文件；系统打开父目录并选中该文件。
        # 不拼接命令行，中文、空格、逗号与引号都按 Unicode 路径传递。
        hr = shell32.SHOpenFolderAndSelectItems(pidl, 0, None, 0)
        if hr != 0:
            raise OSError(f'Windows 未能定位该图纸（0x{hr & 0xffffffff:08X}），请稍后重试。')
        return {'ok': True, 'method': 'windows-shell-selection', 'hresult': hr}
    finally:
        if pidl.value:
            ole32.CoTaskMemFree(pidl)
        if initialized:
            ole32.CoUninitialize()


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('定位需要一个完整的文件路径。')
        result = locate_file(sys.argv[1])
    except Exception as error:
        result = {'ok': False, 'error': str(error)}
    print(json.dumps(result, ensure_ascii=True))
    sys.exit(0 if result['ok'] else 1)
