//! Windows 作业对象：让后端进程及其所有子进程随桌面壳一起结束。
//!
//! 作业对象设置了 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。作业句柄只由桌面壳持有，
//! 桌面壳无论是正常退出、崩溃还是被任务管理器结束，句柄都会被系统关闭，
//! 作业里剩下的进程随之被结束。正常退出时我们会主动调用 `TerminateJobObject`。
//!
//! 为避免"子进程在加入作业之前就派生了孙进程"的竞态，后端进程以挂起状态创建，
//! 加入作业后再恢复它的线程。

use std::io;
use std::mem::{size_of, zeroed};
use std::ptr::null;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

pub struct Job {
    handle: HANDLE,
}

// 作业句柄可以跨线程使用
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    pub fn new() -> io::Result<Self> {
        unsafe {
            let handle = CreateJobObjectW(null(), null());
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Job { handle };
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }
    }

    pub fn assign(&self, process: HANDLE) -> io::Result<()> {
        unsafe {
            if AssignProcessToJobObject(self.handle, process) == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    /// 结束作业中的所有进程
    pub fn terminate(&self) -> io::Result<()> {
        unsafe {
            if TerminateJobObject(self.handle, 1) == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

/// 恢复以 `CREATE_SUSPENDED` 创建的进程的所有线程，返回恢复的线程数
pub fn resume_process_threads(pid: u32) -> io::Result<usize> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut entry: THREADENTRY32 = zeroed();
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut resumed = 0usize;
        let mut ok = Thread32First(snapshot, &mut entry);
        while ok != 0 {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if !thread.is_null() {
                    if ResumeThread(thread) != u32::MAX {
                        resumed += 1;
                    }
                    CloseHandle(thread);
                }
            }
            ok = Thread32Next(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        if resumed == 0 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "没有找到可以恢复的线程",
            ));
        }
        Ok(resumed)
    }
}
