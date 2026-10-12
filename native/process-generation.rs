// Dependency-free macOS generation probe. Output contains no process arguments.
#[cfg(target_os = "macos")]
mod macos {
    use std::{ffi::c_void, mem};
    #[repr(C)]
    #[derive(Default)]
    struct BsdInfo {
        flags: u32, status: u32, xstatus: u32, pid: u32, ppid: u32,
        uid: u32, gid: u32, ruid: u32, rgid: u32, svuid: u32, svgid: u32,
        rfu: u32, comm: [u8; 16], name: [u8; 32], nfiles: u32, pgid: u32,
        pjobc: u32, tdev: u32, tpgid: u32, nice: i32, start_sec: u64, start_usec: u64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Timeval { sec: i64, usec: i32 }
    #[link(name = "proc")]
    extern "C" { fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut c_void, size: i32) -> i32; }
    extern "C" {
        fn sysctlbyname(name: *const u8, old: *mut c_void, len: *mut usize, new: *mut c_void, newlen: usize) -> i32;
    }
    pub fn run() {
        let mut boot = Timeval::default();
        let mut size = mem::size_of::<Timeval>();
        let boot_ok = unsafe { sysctlbyname(b"kern.boottime\0".as_ptr(), &mut boot as *mut _ as *mut c_void, &mut size, std::ptr::null_mut(), 0) } == 0;
        for arg in std::env::args().skip(1) {
            let Ok(pid) = arg.parse::<i32>() else { continue };
            let mut info = BsdInfo::default();
            let size = mem::size_of::<BsdInfo>() as i32;
            let count = unsafe { proc_pidinfo(pid, 3, 0, &mut info as *mut _ as *mut c_void, size) };
            let error = std::io::Error::last_os_error().raw_os_error();
            if count == size && boot_ok {
                println!("{} found {}:{} {}:{}", pid, info.start_sec, info.start_usec, boot.sec, boot.usec);
            } else if count == 0 && error == Some(3) {
                println!("{} absent", pid);
            } else { println!("{} unknown", pid); }
        }
    }
}
fn main() {
    #[cfg(target_os = "macos")]
    macos::run();
    #[cfg(not(target_os = "macos"))]
    std::process::exit(1);
}
