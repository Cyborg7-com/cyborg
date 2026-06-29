// Desktop app download URLs + the cybo runtime install command, shared by the
// onboarding download gate (routes/welcome/download) and the in-app "no daemon
// connected" empty state (AgentsPane). Single source of truth so the release
// links never drift between the two surfaces.
//
// Pinned to the rewrite's electron-builder output — do not alter these URLs.
export const MAC_DMG =
  "https://github.com/Cyborg7-com/cyborg7-releases/releases/latest/download/Cyborg-mac-arm64.dmg";
export const WINDOWS_EXE =
  "https://github.com/Cyborg7-com/cyborg7-releases/releases/latest/download/Cyborg-Setup-Windows-x64.exe";
