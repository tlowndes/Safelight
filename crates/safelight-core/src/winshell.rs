//! Windows-only helpers: thumbnails from the Windows shell (covers HEIC with the HEIF
//! extension, RAW with camera codecs, and video frames) and network-drive detection.

use std::path::Path;

/// Ask Windows for a thumbnail of any file Explorer can preview. Returns RGBA pixels.
pub fn shell_thumbnail(path: &Path, size: i32) -> Option<image::RgbaImage> {
    use std::ffi::c_void;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_RESIZETOFIT,
        SIIGBF_THUMBNAILONLY,
    };

    unsafe {
        // Fine to call repeatedly; an "already initialised" result is not an error for us.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let wide = HSTRING::from(path.as_os_str());
        let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&wide, None).ok()?;
        // THUMBNAILONLY: without it, files Windows has no codec for (CR2 without the Raw Image
        // Extension, HEVC .mov without the HEVC extension) come back as the generic file icon.
        let hbmp = factory
            .GetImage(SIZE { cx: size, cy: size }, SIIGBF_RESIZETOFIT | SIIGBF_BIGGERSIZEOK | SIIGBF_THUMBNAILONLY)
            .ok()?;

        let mut bmp = BITMAP::default();
        let got = GetObjectW(
            hbmp,
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut BITMAP as *mut c_void),
        );
        if got == 0 || bmp.bmWidth <= 0 || bmp.bmHeight <= 0 {
            let _ = DeleteObject(hbmp);
            return None;
        }
        let (w, h) = (bmp.bmWidth, bmp.bmHeight);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let hdc = GetDC(None);
        let lines = GetDIBits(hdc, hbmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut c_void), &mut info, DIB_RGB_COLORS);
        ReleaseDC(None, hdc);
        let _ = DeleteObject(hbmp);
        if lines == 0 {
            return None;
        }
        // BGRA -> RGBA, and force opaque (shell bitmaps often have alpha 0).
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        image::RgbaImage::from_raw(w as u32, h as u32, buf)
    }
}

/// True for mapped network drives and UNC paths, where the Recycle Bin isn't available.
pub fn is_network_path(path: &Path) -> bool {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    let s = path.to_string_lossy();
    if s.starts_with(r"\\") {
        return true;
    }
    let Some(root) = s.get(0..3) else { return false };
    const DRIVE_REMOTE: u32 = 4;
    unsafe { GetDriveTypeW(&HSTRING::from(root)) == DRIVE_REMOTE }
}
