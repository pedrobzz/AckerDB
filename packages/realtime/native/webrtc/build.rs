fn main() {
    napi_build::setup();

    // WebRTC's Apple frameworks contain Objective-C categories. The final
    // addon, not only its dependencies, must ask ld to retain them.
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-ObjC");
}
