"""Hard bounded local process guard. No network, package install or OS mutation."""
import ctypes,sys
from pathlib import Path
class ResourceLimit(RuntimeError):pass
def usage():
    if sys.platform=='win32':
        from ctypes import wintypes
        class Mem(ctypes.Structure):
            _fields_=[('length',wintypes.DWORD),('load',wintypes.DWORD)]+[(n,ctypes.c_ulonglong) for n in ('total','available','page_total','page_available','virtual_total','virtual_available','extended')]
        class Proc(ctypes.Structure):
            _fields_=[('cb',wintypes.DWORD),('faults',wintypes.DWORD)]+[(n,ctypes.c_size_t) for n in ('peak_rss','rss','peak_pool_paged','pool_paged','peak_pool_nonpaged','pool_nonpaged','pagefile','peak_pagefile')]
        m=Mem();m.length=ctypes.sizeof(m);p=Proc();p.cb=ctypes.sizeof(p)
        k=ctypes.windll.kernel32;k.GetCurrentProcess.restype=wintypes.HANDLE
        ctypes.windll.psapi.GetProcessMemoryInfo.argtypes=[wintypes.HANDLE,ctypes.c_void_p,wintypes.DWORD]
        if not k.GlobalMemoryStatusEx(ctypes.byref(m)) or not ctypes.windll.psapi.GetProcessMemoryInfo(k.GetCurrentProcess(),ctypes.byref(p),p.cb):raise ResourceLimit('resource_measurement_unavailable')
        return p.rss,m.available
    if sys.platform.startswith('linux'):
        def number(path,key):
            return int(next(line.split()[1] for line in Path(path).read_text().splitlines() if line.startswith(key+':')))*1024
        return number('/proc/self/status','VmRSS'),number('/proc/meminfo','MemAvailable')
    raise ResourceLimit('resource_measurement_unavailable')
def guard(*,reserve=0):
    try:rss,free=usage()
    except ResourceLimit:raise
    except Exception as exc:raise ResourceLimit('resource_measurement_unavailable') from exc
    if rss+reserve>=4*2**30 or free-reserve<2*2**30:raise ResourceLimit('resource_budget_exceeded')
    return {'rssBytes':rss,'freeBytes':free}
