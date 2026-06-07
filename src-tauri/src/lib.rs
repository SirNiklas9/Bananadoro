#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .setup(|app| {
      // Global (OS-level) shortcuts — desktop only. The shortcut is
      // registered and its start/pause callback supplied from the frontend
      // via the JS API, so the timer logic stays in one place.
      #[cfg(desktop)]
      app.handle().plugin(tauri_plugin_global_shortcut::Builder::new().build())?;

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
