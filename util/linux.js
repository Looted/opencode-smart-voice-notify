/**
 * Linux Platform Compatibility Module
 * 
 * Provides Linux-specific implementations for:
 * - Wake monitor from sleep (X11 and Wayland)
 * - Get current system volume (PulseAudio/PipeWire and ALSA)
 * - Force system volume up (PulseAudio/PipeWire and ALSA)
 * - Play audio files (PulseAudio and ALSA)
 * 
 * Dependencies (optional - graceful fallback if missing):
 * - x11-xserver-utils (for xset on X11)
 * - pulseaudio-utils or pipewire-pulse (for pactl)
 * - alsa-utils (for amixer, aplay, paplay)
 * 
 * @module util/linux
 */

/**
 * Creates a Linux platform utilities instance
 * @param {object} params - { $: shell runner, debugLog: logging function }
 * @returns {object} Linux platform API
 */
export const createLinuxPlatform = ({ $, debugLog = () => {} }) => {
  
  // ============================================================
  // DISPLAY SESSION DETECTION
  // ============================================================
  
  /**
   * Detect if running under Wayland
   * @returns {boolean}
   */
  const isWayland = () => {
    return !!process.env.WAYLAND_DISPLAY;
  };

  /**
   * Detect if running under X11
   * @returns {boolean}
   */
  const isX11 = () => {
    return !!process.env.DISPLAY && !isWayland();
  };

  /**
   * Get current session type
   * @returns {'x11' | 'wayland' | 'tty' | 'unknown'}
   */
  const getSessionType = () => {
    const sessionType = process.env.XDG_SESSION_TYPE;
    if (sessionType === 'x11' || sessionType === 'wayland' || sessionType === 'tty') {
      return sessionType;
    }
    if (isWayland()) return 'wayland';
    if (isX11()) return 'x11';
    return 'unknown';
  };

  // ============================================================
  // WAKE MONITOR
  // ============================================================

  /**
   * Wake monitor using X11 DPMS (works on X11 and often XWayland)
   * @returns {Promise<boolean>} Success status
   */
  const wakeMonitorX11 = async () => {
    if (!$) return false;
    try {
      await $`xset dpms force on`.quiet();
      debugLog('wakeMonitor: X11 xset dpms force on succeeded');
      return true;
    } catch (e) {
      debugLog(`wakeMonitor: X11 xset failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Wake monitor using GNOME D-Bus (for GNOME on Wayland)
   * Triggers a brightness step which wakes the display
   * @returns {Promise<boolean>} Success status
   */
  const wakeMonitorGnomeDBus = async () => {
    if (!$) return false;
    try {
      await $`gdbus call --session --dest org.gnome.SettingsDaemon.Power --object-path /org/gnome/SettingsDaemon/Power --method org.gnome.SettingsDaemon.Power.Screen.StepUp`.quiet();
      debugLog('wakeMonitor: GNOME D-Bus StepUp succeeded');
      return true;
    } catch (e) {
      debugLog(`wakeMonitor: GNOME D-Bus failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Wake monitor from sleep/DPMS standby
   * Tries multiple methods with graceful fallback:
   * 1. X11 xset (works on X11 and XWayland)
   * 2. GNOME D-Bus (works on GNOME Wayland)
   * 
   * @returns {Promise<boolean>} True if any method succeeded
   */
  const wakeMonitor = async () => {
    // Try X11 method first (most compatible, works on XWayland too)
    if (await wakeMonitorX11()) return true;
    
    // Try GNOME Wayland D-Bus method
    if (await wakeMonitorGnomeDBus()) return true;
    
    debugLog('wakeMonitor: all methods failed');
    return false;
  };

  // ============================================================
  // VOLUME CONTROL - PULSEAUDIO / PIPEWIRE
  // ============================================================

  /**
   * Get current volume using PulseAudio/PipeWire (pactl)
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getVolumePulse = async () => {
    if (!$) return -1;
    try {
      const result = await $`pactl get-sink-volume @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Volume: front-left: 65536 / 100% / 0.00 dB, ..."
      const match = output.match(/(\d+)%/);
      if (match) {
        const volume = parseInt(match[1], 10);
        debugLog(`getVolume: pactl returned ${volume}%`);
        return volume;
      }
    } catch (e) {
      debugLog(`getVolume: pactl failed: ${e.message}`);
    }
    return -1;
  };

  /**
   * Set volume using PulseAudio/PipeWire (pactl)
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolumePulse = async (volume) => {
    if (!$) return false;
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await $`pactl set-sink-volume @DEFAULT_SINK@ ${clampedVolume}%`.quiet();
      debugLog(`setVolume: pactl set to ${clampedVolume}%`);
      return true;
    } catch (e) {
      debugLog(`setVolume: pactl failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Unmute using PulseAudio/PipeWire (pactl)
   * @returns {Promise<boolean>} Success status
   */
  const unmutePulse = async () => {
    if (!$) return false;
    try {
      await $`pactl set-sink-mute @DEFAULT_SINK@ 0`.quiet();
      debugLog('unmute: pactl succeeded');
      return true;
    } catch (e) {
      debugLog(`unmute: pactl failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Check if muted using PulseAudio/PipeWire
   * @returns {Promise<boolean|null>} True if muted, false if not, null if failed
   */
  const isMutedPulse = async () => {
    if (!$) return null;
    try {
      const result = await $`pactl get-sink-mute @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Output: "Mute: yes" or "Mute: no"
      return /yes|true/i.test(output);
    } catch (e) {
      debugLog(`isMuted: pactl failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // VOLUME CONTROL - ALSA (FALLBACK)
  // ============================================================

  /**
   * Get current volume using ALSA (amixer)
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getVolumeAlsa = async () => {
    if (!$) return -1;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Front Left: Playback 65536 [75%] [on]"
      const match = output.match(/\[(\d+)%\]/);
      if (match) {
        const volume = parseInt(match[1], 10);
        debugLog(`getVolume: amixer returned ${volume}%`);
        return volume;
      }
    } catch (e) {
      debugLog(`getVolume: amixer failed: ${e.message}`);
    }
    return -1;
  };

  /**
   * Set volume using ALSA (amixer)
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolumeAlsa = async (volume) => {
    if (!$) return false;
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await $`amixer set Master ${clampedVolume}%`.quiet();
      debugLog(`setVolume: amixer set to ${clampedVolume}%`);
      return true;
    } catch (e) {
      debugLog(`setVolume: amixer failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Unmute using ALSA (amixer)
   * @returns {Promise<boolean>} Success status
   */
  const unmuteAlsa = async () => {
    if (!$) return false;
    try {
      await $`amixer set Master unmute`.quiet();
      debugLog('unmute: amixer succeeded');
      return true;
    } catch (e) {
      debugLog(`unmute: amixer failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Check if muted using ALSA
   * @returns {Promise<boolean|null>} True if muted, false if not, null if failed
   */
  const isMutedAlsa = async () => {
    if (!$) return null;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Look for [off] or [mute] in output
      return /\[off\]|\[mute\]/i.test(output);
    } catch (e) {
      debugLog(`isMuted: amixer failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // UNIFIED VOLUME CONTROL (AUTO-DETECT BACKEND)
  // ============================================================

  /**
   * Get current system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getCurrentVolume = async () => {
    // Try PulseAudio/PipeWire first (most common on desktop Linux)
    let volume = await getVolumePulse();
    if (volume >= 0) return volume;
    
    // Fallback to ALSA
    volume = await getVolumeAlsa();
    return volume;
  };

  /**
   * Set system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolume = async (volume) => {
    // Try PulseAudio/PipeWire first
    if (await setVolumePulse(volume)) return true;
    
    // Fallback to ALSA
    return await setVolumeAlsa(volume);
  };

  /**
   * Unmute system audio
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<boolean>} Success status
   */
  const unmute = async () => {
    // Try PulseAudio/PipeWire first
    if (await unmutePulse()) return true;
    
    // Fallback to ALSA
    return await unmuteAlsa();
  };

  /**
   * Check if system audio is muted
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<boolean|null>} True if muted, false if not, null if detection failed
   */
  const isMuted = async () => {
    // Try PulseAudio/PipeWire first
    let muted = await isMutedPulse();
    if (muted !== null) return muted;
    
    // Fallback to ALSA
    return await isMutedAlsa();
  };

  /**
   * Force volume to maximum (unmute + set to 100%)
   * Used to ensure notifications are audible
   * @returns {Promise<boolean>} Success status
   */
  const forceVolume = async () => {
    const unmuted = await unmute();
    const volumeSet = await setVolume(100);
    return unmuted || volumeSet;
  };

  /**
   * Force volume if below threshold
   * @param {number} threshold - Minimum volume threshold (0-100)
   * @returns {Promise<boolean>} True if volume was forced, false if already adequate
   */
  const forceVolumeIfNeeded = async (threshold = 50) => {
    const currentVolume = await getCurrentVolume();
    
    // If we couldn't detect volume, force it to be safe
    if (currentVolume < 0) {
      debugLog('forceVolumeIfNeeded: could not detect volume, forcing');
      return await forceVolume();
    }
    
    // Check if already above threshold
    if (currentVolume >= threshold) {
      debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% >= ${threshold}%, no action needed`);
      return false;
    }
    
    // Force volume up
    debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% < ${threshold}%, forcing to 100%`);
    return await forceVolume();
  };

  // ============================================================
  // WSL2 SUPPORT
  // ============================================================
  
  /**
   * Detect if running in WSL2
   * @returns {boolean}
   */
  const isWSL2 = () => {
    try {
      const fs = require('fs');
      if (fs.existsSync('/proc/version')) {
        const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
        return version.includes('microsoft') && version.includes('wsl2');
      }
    } catch (e) {
      debugLog(`isWSL2: detection failed: ${e.message}`);
    }
    return false;
  };
  
  /**
   * Play audio file on Windows host via PowerShell (for WSL2)
   * Handles path conversion and file copying to Windows side for access
   * @param {string} filePath - WSL path to audio file
   * @returns {Promise<boolean>} Success status
   */
  const playAudioWSL2 = async (filePath) => {
    if (!1000 4 20 24 25 27 29 30 44 46 117 1000 1001 return false;
    try {
      const path = require("path");
      const fileName = path.basename(filePath) || "audio.mp3";
      const timestamp = Date.now();
      const tempFileName = `opencode-audio--`;
      const wslTempPath = `/mnt/c/Users/Public/`;
      const windowsTempPath = `C:\Users\Public\`;
      
      debugLog(`playAudioWSL2: copying  to `);
      
      await /**
 * Linux Platform Compatibility Module
 * 
 * Provides Linux-specific implementations for:
 * - Wake monitor from sleep (X11 and Wayland)
 * - Get current system volume (PulseAudio/PipeWire and ALSA)
 * - Force system volume up (PulseAudio/PipeWire and ALSA)
 * - Play audio files (PulseAudio and ALSA)
 * 
 * Dependencies (optional - graceful fallback if missing):
 * - x11-xserver-utils (for xset on X11)
 * - pulseaudio-utils or pipewire-pulse (for pactl)
 * - alsa-utils (for amixer, aplay, paplay)
 * 
 * @module util/linux
 */

/**
 * Creates a Linux platform utilities instance
 * @param {object} params - { $: shell runner, debugLog: logging function }
 * @returns {object} Linux platform API
 */
export const createLinuxPlatform = ({ $, debugLog = () => {} }) => {
  
  // ============================================================
  // DISPLAY SESSION DETECTION
  // ============================================================
  
  /**
   * Detect if running under Wayland
   * @returns {boolean}
   */
  const isWayland = () => {
    return !!process.env.WAYLAND_DISPLAY;
  };

  /**
   * Detect if running under X11
   * @returns {boolean}
   */
  const isX11 = () => {
    return !!process.env.DISPLAY && !isWayland();
  };

  /**
   * Get current session type
   * @returns {'x11' | 'wayland' | 'tty' | 'unknown'}
   */
  const getSessionType = () => {
    const sessionType = process.env.XDG_SESSION_TYPE;
    if (sessionType === 'x11' || sessionType === 'wayland' || sessionType === 'tty') {
      return sessionType;
    }
    if (isWayland()) return 'wayland';
    if (isX11()) return 'x11';
    return 'unknown';
  };

  // ============================================================
  // WAKE MONITOR
  // ============================================================

  /**
   * Wake monitor using X11 DPMS (works on X11 and often XWayland)
   * @returns {Promise<boolean>} Success status
   */
  const wakeMonitorX11 = async () => {
    if (!$) return false;
    try {
      await $`xset dpms force on`.quiet();
      debugLog('wakeMonitor: X11 xset dpms force on succeeded');
      return true;
    } catch (e) {
      debugLog(`wakeMonitor: X11 xset failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Wake monitor using GNOME D-Bus (for GNOME on Wayland)
   * Triggers a brightness step which wakes the display
   * @returns {Promise<boolean>} Success status
   */
  const wakeMonitorGnomeDBus = async () => {
    if (!$) return false;
    try {
      await $`gdbus call --session --dest org.gnome.SettingsDaemon.Power --object-path /org/gnome/SettingsDaemon/Power --method org.gnome.SettingsDaemon.Power.Screen.StepUp`.quiet();
      debugLog('wakeMonitor: GNOME D-Bus StepUp succeeded');
      return true;
    } catch (e) {
      debugLog(`wakeMonitor: GNOME D-Bus failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Wake monitor from sleep/DPMS standby
   * Tries multiple methods with graceful fallback:
   * 1. X11 xset (works on X11 and XWayland)
   * 2. GNOME D-Bus (works on GNOME Wayland)
   * 
   * @returns {Promise<boolean>} True if any method succeeded
   */
  const wakeMonitor = async () => {
    // Try X11 method first (most compatible, works on XWayland too)
    if (await wakeMonitorX11()) return true;
    
    // Try GNOME Wayland D-Bus method
    if (await wakeMonitorGnomeDBus()) return true;
    
    debugLog('wakeMonitor: all methods failed');
    return false;
  };

  // ============================================================
  // VOLUME CONTROL - PULSEAUDIO / PIPEWIRE
  // ============================================================

  /**
   * Get current volume using PulseAudio/PipeWire (pactl)
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getVolumePulse = async () => {
    if (!$) return -1;
    try {
      const result = await $`pactl get-sink-volume @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Volume: front-left: 65536 / 100% / 0.00 dB, ..."
      const match = output.match(/(\d+)%/);
      if (match) {
        const volume = parseInt(match[1], 10);
        debugLog(`getVolume: pactl returned ${volume}%`);
        return volume;
      }
    } catch (e) {
      debugLog(`getVolume: pactl failed: ${e.message}`);
    }
    return -1;
  };

  /**
   * Set volume using PulseAudio/PipeWire (pactl)
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolumePulse = async (volume) => {
    if (!$) return false;
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await $`pactl set-sink-volume @DEFAULT_SINK@ ${clampedVolume}%`.quiet();
      debugLog(`setVolume: pactl set to ${clampedVolume}%`);
      return true;
    } catch (e) {
      debugLog(`setVolume: pactl failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Unmute using PulseAudio/PipeWire (pactl)
   * @returns {Promise<boolean>} Success status
   */
  const unmutePulse = async () => {
    if (!$) return false;
    try {
      await $`pactl set-sink-mute @DEFAULT_SINK@ 0`.quiet();
      debugLog('unmute: pactl succeeded');
      return true;
    } catch (e) {
      debugLog(`unmute: pactl failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Check if muted using PulseAudio/PipeWire
   * @returns {Promise<boolean|null>} True if muted, false if not, null if failed
   */
  const isMutedPulse = async () => {
    if (!$) return null;
    try {
      const result = await $`pactl get-sink-mute @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Output: "Mute: yes" or "Mute: no"
      return /yes|true/i.test(output);
    } catch (e) {
      debugLog(`isMuted: pactl failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // VOLUME CONTROL - ALSA (FALLBACK)
  // ============================================================

  /**
   * Get current volume using ALSA (amixer)
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getVolumeAlsa = async () => {
    if (!$) return -1;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Front Left: Playback 65536 [75%] [on]"
      const match = output.match(/\[(\d+)%\]/);
      if (match) {
        const volume = parseInt(match[1], 10);
        debugLog(`getVolume: amixer returned ${volume}%`);
        return volume;
      }
    } catch (e) {
      debugLog(`getVolume: amixer failed: ${e.message}`);
    }
    return -1;
  };

  /**
   * Set volume using ALSA (amixer)
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolumeAlsa = async (volume) => {
    if (!$) return false;
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await $`amixer set Master ${clampedVolume}%`.quiet();
      debugLog(`setVolume: amixer set to ${clampedVolume}%`);
      return true;
    } catch (e) {
      debugLog(`setVolume: amixer failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Unmute using ALSA (amixer)
   * @returns {Promise<boolean>} Success status
   */
  const unmuteAlsa = async () => {
    if (!$) return false;
    try {
      await $`amixer set Master unmute`.quiet();
      debugLog('unmute: amixer succeeded');
      return true;
    } catch (e) {
      debugLog(`unmute: amixer failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Check if muted using ALSA
   * @returns {Promise<boolean|null>} True if muted, false if not, null if failed
   */
  const isMutedAlsa = async () => {
    if (!$) return null;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Look for [off] or [mute] in output
      return /\[off\]|\[mute\]/i.test(output);
    } catch (e) {
      debugLog(`isMuted: amixer failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // UNIFIED VOLUME CONTROL (AUTO-DETECT BACKEND)
  // ============================================================

  /**
   * Get current system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getCurrentVolume = async () => {
    // Try PulseAudio/PipeWire first (most common on desktop Linux)
    let volume = await getVolumePulse();
    if (volume >= 0) return volume;
    
    // Fallback to ALSA
    volume = await getVolumeAlsa();
    return volume;
  };

  /**
   * Set system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolume = async (volume) => {
    // Try PulseAudio/PipeWire first
    if (await setVolumePulse(volume)) return true;
    
    // Fallback to ALSA
    return await setVolumeAlsa(volume);
  };

  /**
   * Unmute system audio
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<boolean>} Success status
   */
  const unmute = async () => {
    // Try PulseAudio/PipeWire first
    if (await unmutePulse()) return true;
    
    // Fallback to ALSA
    return await unmuteAlsa();
  };

  /**
   * Check if system audio is muted
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<boolean|null>} True if muted, false if not, null if detection failed
   */
  const isMuted = async () => {
    // Try PulseAudio/PipeWire first
    let muted = await isMutedPulse();
    if (muted !== null) return muted;
    
    // Fallback to ALSA
    return await isMutedAlsa();
  };

  /**
   * Force volume to maximum (unmute + set to 100%)
   * Used to ensure notifications are audible
   * @returns {Promise<boolean>} Success status
   */
  const forceVolume = async () => {
    const unmuted = await unmute();
    const volumeSet = await setVolume(100);
    return unmuted || volumeSet;
  };

  /**
   * Force volume if below threshold
   * @param {number} threshold - Minimum volume threshold (0-100)
   * @returns {Promise<boolean>} True if volume was forced, false if already adequate
   */
  const forceVolumeIfNeeded = async (threshold = 50) => {
    const currentVolume = await getCurrentVolume();
    
    // If we couldn't detect volume, force it to be safe
    if (currentVolume < 0) {
      debugLog('forceVolumeIfNeeded: could not detect volume, forcing');
      return await forceVolume();
    }
    
    // Check if already above threshold
    if (currentVolume >= threshold) {
      debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% >= ${threshold}%, no action needed`);
      return false;
    }
    
    // Force volume up
    debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% < ${threshold}%, forcing to 100%`);
    return await forceVolume();
  };

  // ============================================================
  // WSL2 SUPPORT
  // ============================================================
  
  /**
   * Detect if running in WSL2
   * @returns {boolean}
   */
  const isWSL2 = () => {
    try {
      const fs = require('fs');
      if (fs.existsSync('/proc/version')) {
        const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
        return version.includes('microsoft') && version.includes('wsl2');
      }
    } catch (e) {
      debugLog(`isWSL2: detection failed: ${e.message}`);
    }
    return false;
  };
  
  /**
   * Play audio file on Windows host via PowerShell (for WSL2)
   * Handles path conversion and file copying to Windows side for access
   * @param {string} filePath - WSL path to audio file
   * @returns {Promise<boolean>} Success status
   */
  cp "" ""`.quiet();
      
      debugLog(`playAudioWSL2: playing  via PowerShell MediaPlayer`);
      
      const psScript = `
        Add-Type -AssemblyName PresentationCore
         = New-Object System.Windows.Media.MediaPlayer
        .Open((New-Object System.Uri ""))
        
         = 0
        while (.NaturalDuration.HasTimeSpan -eq  -and  -lt 20) { 
            Start-Sleep -Milliseconds 100
             += 1
        }
        
         = 5
        if (.NaturalDuration.HasTimeSpan) { 
             = .NaturalDuration.TimeSpan.TotalSeconds 
        }
        
        .Play()
        Start-Sleep -Seconds ( + 1)
        .Close()
      `;

      const psBuffer = Buffer.from(psScript, "utf16le");
      const psBase64 = psBuffer.toString("base64");
      
      await /**
 * Linux Platform Compatibility Module
 * 
 * Provides Linux-specific implementations for:
 * - Wake monitor from sleep (X11 and Wayland)
 * - Get current system volume (PulseAudio/PipeWire and ALSA)
 * - Force system volume up (PulseAudio/PipeWire and ALSA)
 * - Play audio files (PulseAudio and ALSA)
 * 
 * Dependencies (optional - graceful fallback if missing):
 * - x11-xserver-utils (for xset on X11)
 * - pulseaudio-utils or pipewire-pulse (for pactl)
 * - alsa-utils (for amixer, aplay, paplay)
 * 
 * @module util/linux
 */

/**
 * Creates a Linux platform utilities instance
 * @param {object} params - { $: shell runner, debugLog: logging function }
 * @returns {object} Linux platform API
 */
export const createLinuxPlatform = ({ $, debugLog = () => {} }) => {
  
  // ============================================================
  // DISPLAY SESSION DETECTION
  // ============================================================
  
  /**
   * Detect if running under Wayland
   * @returns {boolean}
   */
  const isWayland = () => {
    return !!process.env.WAYLAND_DISPLAY;
  };

  /**
   * Detect if running under X11
   * @returns {boolean}
   */
  const isX11 = () => {
    return !!process.env.DISPLAY && !isWayland();
  };

  /**
   * Get current session type
   * @returns {'x11' | 'wayland' | 'tty' | 'unknown'}
   */
  const getSessionType = () => {
    const sessionType = process.env.XDG_SESSION_TYPE;
    if (sessionType === 'x11' || sessionType === 'wayland' || sessionType === 'tty') {
      return sessionType;
    }
    if (isWayland()) return 'wayland';
    if (isX11()) return 'x11';
    return 'unknown';
  };

  // ============================================================
  // WAKE MONITOR
  // ============================================================

  /**
   * Wake monitor using X11 DPMS (works on X11 and often XWayland)
   * @returns {Promise<boolean>} Success status
   */
  const wakeMonitorX11 = async () => {
    if (!$) return false;
    try {
      await $`xset dpms force on`.quiet();
      debugLog('wakeMonitor: X11 xset dpms force on succeeded');
      return true;
    } catch (e) {
      debugLog(`wakeMonitor: X11 xset failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Wake monitor using GNOME D-Bus (for GNOME on Wayland)
   * Triggers a brightness step which wakes the display
   * @returns {Promise<boolean>} Success status
   */
  const wakeMonitorGnomeDBus = async () => {
    if (!$) return false;
    try {
      await $`gdbus call --session --dest org.gnome.SettingsDaemon.Power --object-path /org/gnome/SettingsDaemon/Power --method org.gnome.SettingsDaemon.Power.Screen.StepUp`.quiet();
      debugLog('wakeMonitor: GNOME D-Bus StepUp succeeded');
      return true;
    } catch (e) {
      debugLog(`wakeMonitor: GNOME D-Bus failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Wake monitor from sleep/DPMS standby
   * Tries multiple methods with graceful fallback:
   * 1. X11 xset (works on X11 and XWayland)
   * 2. GNOME D-Bus (works on GNOME Wayland)
   * 
   * @returns {Promise<boolean>} True if any method succeeded
   */
  const wakeMonitor = async () => {
    // Try X11 method first (most compatible, works on XWayland too)
    if (await wakeMonitorX11()) return true;
    
    // Try GNOME Wayland D-Bus method
    if (await wakeMonitorGnomeDBus()) return true;
    
    debugLog('wakeMonitor: all methods failed');
    return false;
  };

  // ============================================================
  // VOLUME CONTROL - PULSEAUDIO / PIPEWIRE
  // ============================================================

  /**
   * Get current volume using PulseAudio/PipeWire (pactl)
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getVolumePulse = async () => {
    if (!$) return -1;
    try {
      const result = await $`pactl get-sink-volume @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Volume: front-left: 65536 / 100% / 0.00 dB, ..."
      const match = output.match(/(\d+)%/);
      if (match) {
        const volume = parseInt(match[1], 10);
        debugLog(`getVolume: pactl returned ${volume}%`);
        return volume;
      }
    } catch (e) {
      debugLog(`getVolume: pactl failed: ${e.message}`);
    }
    return -1;
  };

  /**
   * Set volume using PulseAudio/PipeWire (pactl)
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolumePulse = async (volume) => {
    if (!$) return false;
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await $`pactl set-sink-volume @DEFAULT_SINK@ ${clampedVolume}%`.quiet();
      debugLog(`setVolume: pactl set to ${clampedVolume}%`);
      return true;
    } catch (e) {
      debugLog(`setVolume: pactl failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Unmute using PulseAudio/PipeWire (pactl)
   * @returns {Promise<boolean>} Success status
   */
  const unmutePulse = async () => {
    if (!$) return false;
    try {
      await $`pactl set-sink-mute @DEFAULT_SINK@ 0`.quiet();
      debugLog('unmute: pactl succeeded');
      return true;
    } catch (e) {
      debugLog(`unmute: pactl failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Check if muted using PulseAudio/PipeWire
   * @returns {Promise<boolean|null>} True if muted, false if not, null if failed
   */
  const isMutedPulse = async () => {
    if (!$) return null;
    try {
      const result = await $`pactl get-sink-mute @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Output: "Mute: yes" or "Mute: no"
      return /yes|true/i.test(output);
    } catch (e) {
      debugLog(`isMuted: pactl failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // VOLUME CONTROL - ALSA (FALLBACK)
  // ============================================================

  /**
   * Get current volume using ALSA (amixer)
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getVolumeAlsa = async () => {
    if (!$) return -1;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Front Left: Playback 65536 [75%] [on]"
      const match = output.match(/\[(\d+)%\]/);
      if (match) {
        const volume = parseInt(match[1], 10);
        debugLog(`getVolume: amixer returned ${volume}%`);
        return volume;
      }
    } catch (e) {
      debugLog(`getVolume: amixer failed: ${e.message}`);
    }
    return -1;
  };

  /**
   * Set volume using ALSA (amixer)
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolumeAlsa = async (volume) => {
    if (!$) return false;
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await $`amixer set Master ${clampedVolume}%`.quiet();
      debugLog(`setVolume: amixer set to ${clampedVolume}%`);
      return true;
    } catch (e) {
      debugLog(`setVolume: amixer failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Unmute using ALSA (amixer)
   * @returns {Promise<boolean>} Success status
   */
  const unmuteAlsa = async () => {
    if (!$) return false;
    try {
      await $`amixer set Master unmute`.quiet();
      debugLog('unmute: amixer succeeded');
      return true;
    } catch (e) {
      debugLog(`unmute: amixer failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Check if muted using ALSA
   * @returns {Promise<boolean|null>} True if muted, false if not, null if failed
   */
  const isMutedAlsa = async () => {
    if (!$) return null;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Look for [off] or [mute] in output
      return /\[off\]|\[mute\]/i.test(output);
    } catch (e) {
      debugLog(`isMuted: amixer failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // UNIFIED VOLUME CONTROL (AUTO-DETECT BACKEND)
  // ============================================================

  /**
   * Get current system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getCurrentVolume = async () => {
    // Try PulseAudio/PipeWire first (most common on desktop Linux)
    let volume = await getVolumePulse();
    if (volume >= 0) return volume;
    
    // Fallback to ALSA
    volume = await getVolumeAlsa();
    return volume;
  };

  /**
   * Set system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolume = async (volume) => {
    // Try PulseAudio/PipeWire first
    if (await setVolumePulse(volume)) return true;
    
    // Fallback to ALSA
    return await setVolumeAlsa(volume);
  };

  /**
   * Unmute system audio
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<boolean>} Success status
   */
  const unmute = async () => {
    // Try PulseAudio/PipeWire first
    if (await unmutePulse()) return true;
    
    // Fallback to ALSA
    return await unmuteAlsa();
  };

  /**
   * Check if system audio is muted
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<boolean|null>} True if muted, false if not, null if detection failed
   */
  const isMuted = async () => {
    // Try PulseAudio/PipeWire first
    let muted = await isMutedPulse();
    if (muted !== null) return muted;
    
    // Fallback to ALSA
    return await isMutedAlsa();
  };

  /**
   * Force volume to maximum (unmute + set to 100%)
   * Used to ensure notifications are audible
   * @returns {Promise<boolean>} Success status
   */
  const forceVolume = async () => {
    const unmuted = await unmute();
    const volumeSet = await setVolume(100);
    return unmuted || volumeSet;
  };

  /**
   * Force volume if below threshold
   * @param {number} threshold - Minimum volume threshold (0-100)
   * @returns {Promise<boolean>} True if volume was forced, false if already adequate
   */
  const forceVolumeIfNeeded = async (threshold = 50) => {
    const currentVolume = await getCurrentVolume();
    
    // If we couldn't detect volume, force it to be safe
    if (currentVolume < 0) {
      debugLog('forceVolumeIfNeeded: could not detect volume, forcing');
      return await forceVolume();
    }
    
    // Check if already above threshold
    if (currentVolume >= threshold) {
      debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% >= ${threshold}%, no action needed`);
      return false;
    }
    
    // Force volume up
    debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% < ${threshold}%, forcing to 100%`);
    return await forceVolume();
  };

  // ============================================================
  // WSL2 SUPPORT
  // ============================================================
  
  /**
   * Detect if running in WSL2
   * @returns {boolean}
   */
  const isWSL2 = () => {
    try {
      const fs = require('fs');
      if (fs.existsSync('/proc/version')) {
        const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
        return version.includes('microsoft') && version.includes('wsl2');
      }
    } catch (e) {
      debugLog(`isWSL2: detection failed: ${e.message}`);
    }
    return false;
  };
  
  /**
   * Play audio file on Windows host via PowerShell (for WSL2)
   * Handles path conversion and file copying to Windows side for access
   * @param {string} filePath - WSL path to audio file
   * @returns {Promise<boolean>} Success status
   */
  powershell.exe -EncodedCommand `.quiet();
      
      debugLog(`playAudioWSL2: playback finished`);
      
      /**
 * Linux Platform Compatibility Module
 * 
 * Provides Linux-specific implementations for:
 * - Wake monitor from sleep (X11 and Wayland)
 * - Get current system volume (PulseAudio/PipeWire and ALSA)
 * - Force system volume up (PulseAudio/PipeWire and ALSA)
 * - Play audio files (PulseAudio and ALSA)
 * 
 * Dependencies (optional - graceful fallback if missing):
 * - x11-xserver-utils (for xset on X11)
 * - pulseaudio-utils or pipewire-pulse (for pactl)
 * - alsa-utils (for amixer, aplay, paplay)
 * 
 * @module util/linux
 */

/**
 * Creates a Linux platform utilities instance
 * @param {object} params - { $: shell runner, debugLog: logging function }
 * @returns {object} Linux platform API
 */
export const createLinuxPlatform = ({ $, debugLog = () => {} }) => {
  
  // ============================================================
  // DISPLAY SESSION DETECTION
  // ============================================================
  
  /**
   * Detect if running under Wayland
   * @returns {boolean}
   */
  const isWayland = () => {
    return !!process.env.WAYLAND_DISPLAY;
  };

  /**
   * Detect if running under X11
   * @returns {boolean}
   */
  const isX11 = () => {
    return !!process.env.DISPLAY && !isWayland();
  };

  /**
   * Get current session type
   * @returns {'x11' | 'wayland' | 'tty' | 'unknown'}
   */
  const getSessionType = () => {
    const sessionType = process.env.XDG_SESSION_TYPE;
    if (sessionType === 'x11' || sessionType === 'wayland' || sessionType === 'tty') {
      return sessionType;
    }
    if (isWayland()) return 'wayland';
    if (isX11()) return 'x11';
    return 'unknown';
  };

  // ============================================================
  // WAKE MONITOR
  // ============================================================

  /**
   * Wake monitor using X11 DPMS (works on X11 and often XWayland)
   * @returns {Promise<boolean>} Success status
   */
  const wakeMonitorX11 = async () => {
    if (!$) return false;
    try {
      await $`xset dpms force on`.quiet();
      debugLog('wakeMonitor: X11 xset dpms force on succeeded');
      return true;
    } catch (e) {
      debugLog(`wakeMonitor: X11 xset failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Wake monitor using GNOME D-Bus (for GNOME on Wayland)
   * Triggers a brightness step which wakes the display
   * @returns {Promise<boolean>} Success status
   */
  const wakeMonitorGnomeDBus = async () => {
    if (!$) return false;
    try {
      await $`gdbus call --session --dest org.gnome.SettingsDaemon.Power --object-path /org/gnome/SettingsDaemon/Power --method org.gnome.SettingsDaemon.Power.Screen.StepUp`.quiet();
      debugLog('wakeMonitor: GNOME D-Bus StepUp succeeded');
      return true;
    } catch (e) {
      debugLog(`wakeMonitor: GNOME D-Bus failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Wake monitor from sleep/DPMS standby
   * Tries multiple methods with graceful fallback:
   * 1. X11 xset (works on X11 and XWayland)
   * 2. GNOME D-Bus (works on GNOME Wayland)
   * 
   * @returns {Promise<boolean>} True if any method succeeded
   */
  const wakeMonitor = async () => {
    // Try X11 method first (most compatible, works on XWayland too)
    if (await wakeMonitorX11()) return true;
    
    // Try GNOME Wayland D-Bus method
    if (await wakeMonitorGnomeDBus()) return true;
    
    debugLog('wakeMonitor: all methods failed');
    return false;
  };

  // ============================================================
  // VOLUME CONTROL - PULSEAUDIO / PIPEWIRE
  // ============================================================

  /**
   * Get current volume using PulseAudio/PipeWire (pactl)
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getVolumePulse = async () => {
    if (!$) return -1;
    try {
      const result = await $`pactl get-sink-volume @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Volume: front-left: 65536 / 100% / 0.00 dB, ..."
      const match = output.match(/(\d+)%/);
      if (match) {
        const volume = parseInt(match[1], 10);
        debugLog(`getVolume: pactl returned ${volume}%`);
        return volume;
      }
    } catch (e) {
      debugLog(`getVolume: pactl failed: ${e.message}`);
    }
    return -1;
  };

  /**
   * Set volume using PulseAudio/PipeWire (pactl)
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolumePulse = async (volume) => {
    if (!$) return false;
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await $`pactl set-sink-volume @DEFAULT_SINK@ ${clampedVolume}%`.quiet();
      debugLog(`setVolume: pactl set to ${clampedVolume}%`);
      return true;
    } catch (e) {
      debugLog(`setVolume: pactl failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Unmute using PulseAudio/PipeWire (pactl)
   * @returns {Promise<boolean>} Success status
   */
  const unmutePulse = async () => {
    if (!$) return false;
    try {
      await $`pactl set-sink-mute @DEFAULT_SINK@ 0`.quiet();
      debugLog('unmute: pactl succeeded');
      return true;
    } catch (e) {
      debugLog(`unmute: pactl failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Check if muted using PulseAudio/PipeWire
   * @returns {Promise<boolean|null>} True if muted, false if not, null if failed
   */
  const isMutedPulse = async () => {
    if (!$) return null;
    try {
      const result = await $`pactl get-sink-mute @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Output: "Mute: yes" or "Mute: no"
      return /yes|true/i.test(output);
    } catch (e) {
      debugLog(`isMuted: pactl failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // VOLUME CONTROL - ALSA (FALLBACK)
  // ============================================================

  /**
   * Get current volume using ALSA (amixer)
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getVolumeAlsa = async () => {
    if (!$) return -1;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Front Left: Playback 65536 [75%] [on]"
      const match = output.match(/\[(\d+)%\]/);
      if (match) {
        const volume = parseInt(match[1], 10);
        debugLog(`getVolume: amixer returned ${volume}%`);
        return volume;
      }
    } catch (e) {
      debugLog(`getVolume: amixer failed: ${e.message}`);
    }
    return -1;
  };

  /**
   * Set volume using ALSA (amixer)
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolumeAlsa = async (volume) => {
    if (!$) return false;
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await $`amixer set Master ${clampedVolume}%`.quiet();
      debugLog(`setVolume: amixer set to ${clampedVolume}%`);
      return true;
    } catch (e) {
      debugLog(`setVolume: amixer failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Unmute using ALSA (amixer)
   * @returns {Promise<boolean>} Success status
   */
  const unmuteAlsa = async () => {
    if (!$) return false;
    try {
      await $`amixer set Master unmute`.quiet();
      debugLog('unmute: amixer succeeded');
      return true;
    } catch (e) {
      debugLog(`unmute: amixer failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Check if muted using ALSA
   * @returns {Promise<boolean|null>} True if muted, false if not, null if failed
   */
  const isMutedAlsa = async () => {
    if (!$) return null;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Look for [off] or [mute] in output
      return /\[off\]|\[mute\]/i.test(output);
    } catch (e) {
      debugLog(`isMuted: amixer failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // UNIFIED VOLUME CONTROL (AUTO-DETECT BACKEND)
  // ============================================================

  /**
   * Get current system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getCurrentVolume = async () => {
    // Try PulseAudio/PipeWire first (most common on desktop Linux)
    let volume = await getVolumePulse();
    if (volume >= 0) return volume;
    
    // Fallback to ALSA
    volume = await getVolumeAlsa();
    return volume;
  };

  /**
   * Set system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolume = async (volume) => {
    // Try PulseAudio/PipeWire first
    if (await setVolumePulse(volume)) return true;
    
    // Fallback to ALSA
    return await setVolumeAlsa(volume);
  };

  /**
   * Unmute system audio
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<boolean>} Success status
   */
  const unmute = async () => {
    // Try PulseAudio/PipeWire first
    if (await unmutePulse()) return true;
    
    // Fallback to ALSA
    return await unmuteAlsa();
  };

  /**
   * Check if system audio is muted
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<boolean|null>} True if muted, false if not, null if detection failed
   */
  const isMuted = async () => {
    // Try PulseAudio/PipeWire first
    let muted = await isMutedPulse();
    if (muted !== null) return muted;
    
    // Fallback to ALSA
    return await isMutedAlsa();
  };

  /**
   * Force volume to maximum (unmute + set to 100%)
   * Used to ensure notifications are audible
   * @returns {Promise<boolean>} Success status
   */
  const forceVolume = async () => {
    const unmuted = await unmute();
    const volumeSet = await setVolume(100);
    return unmuted || volumeSet;
  };

  /**
   * Force volume if below threshold
   * @param {number} threshold - Minimum volume threshold (0-100)
   * @returns {Promise<boolean>} True if volume was forced, false if already adequate
   */
  const forceVolumeIfNeeded = async (threshold = 50) => {
    const currentVolume = await getCurrentVolume();
    
    // If we couldn't detect volume, force it to be safe
    if (currentVolume < 0) {
      debugLog('forceVolumeIfNeeded: could not detect volume, forcing');
      return await forceVolume();
    }
    
    // Check if already above threshold
    if (currentVolume >= threshold) {
      debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% >= ${threshold}%, no action needed`);
      return false;
    }
    
    // Force volume up
    debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% < ${threshold}%, forcing to 100%`);
    return await forceVolume();
  };

  // ============================================================
  // WSL2 SUPPORT
  // ============================================================
  
  /**
   * Detect if running in WSL2
   * @returns {boolean}
   */
  const isWSL2 = () => {
    try {
      const fs = require('fs');
      if (fs.existsSync('/proc/version')) {
        const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
        return version.includes('microsoft') && version.includes('wsl2');
      }
    } catch (e) {
      debugLog(`isWSL2: detection failed: ${e.message}`);
    }
    return false;
  };
  
  /**
   * Play audio file on Windows host via PowerShell (for WSL2)
   * Handles path conversion and file copying to Windows side for access
   * @param {string} filePath - WSL path to audio file
   * @returns {Promise<boolean>} Success status
   */
  rm ""`.quiet().catch(e => debugLog(`playAudioWSL2: cleanup failed: `));
      
      return true;
    } catch (e) {
      debugLog(`playAudioWSL2: failed: `);
      return false;
    }
  };

  /**
   * Detect if running under X11
   * @returns {boolean}
   */
  const isX11 = () => {
    return !!process.env.DISPLAY && !isWayland();
  };

  /**
   * Get current session type
   * @returns {'x11' | 'wayland' | 'tty' | 'unknown'}
   */
  const getSessionType = () => {
    const sessionType = process.env.XDG_SESSION_TYPE;
    if (sessionType === 'x11' || sessionType === 'wayland' || sessionType === 'tty') {
      return sessionType;
    }
    if (isWayland()) return 'wayland';
    if (isX11()) return 'x11';
    return 'unknown';
  };

  // ============================================================
  // WAKE MONITOR
  // ============================================================

  /**
   * Wake monitor using X11 DPMS (works on X11 and often XWayland)
   * @returns {Promise<boolean>} Success status
   */
  const wakeMonitorX11 = async () => {
    if (!$) return false;
    try {
      await $`xset dpms force on`.quiet();
      debugLog('wakeMonitor: X11 xset dpms force on succeeded');
      return true;
    } catch (e) {
      debugLog(`wakeMonitor: X11 xset failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Wake monitor using GNOME D-Bus (for GNOME on Wayland)
   * Triggers a brightness step which wakes the display
   * @returns {Promise<boolean>} Success status
   */
  const wakeMonitorGnomeDBus = async () => {
    if (!$) return false;
    try {
      await $`gdbus call --session --dest org.gnome.SettingsDaemon.Power --object-path /org/gnome/SettingsDaemon/Power --method org.gnome.SettingsDaemon.Power.Screen.StepUp`.quiet();
      debugLog('wakeMonitor: GNOME D-Bus StepUp succeeded');
      return true;
    } catch (e) {
      debugLog(`wakeMonitor: GNOME D-Bus failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Wake monitor from sleep/DPMS standby
   * Tries multiple methods with graceful fallback:
   * 1. X11 xset (works on X11 and XWayland)
   * 2. GNOME D-Bus (works on GNOME Wayland)
   * 
   * @returns {Promise<boolean>} True if any method succeeded
   */
  const wakeMonitor = async () => {
    // Try X11 method first (most compatible, works on XWayland too)
    if (await wakeMonitorX11()) return true;
    
    // Try GNOME Wayland D-Bus method
    if (await wakeMonitorGnomeDBus()) return true;
    
    debugLog('wakeMonitor: all methods failed');
    return false;
  };

  // ============================================================
  // VOLUME CONTROL - PULSEAUDIO / PIPEWIRE
  // ============================================================

  /**
   * Get current volume using PulseAudio/PipeWire (pactl)
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getVolumePulse = async () => {
    if (!$) return -1;
    try {
      const result = await $`pactl get-sink-volume @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Volume: front-left: 65536 / 100% / 0.00 dB, ..."
      const match = output.match(/(\d+)%/);
      if (match) {
        const volume = parseInt(match[1], 10);
        debugLog(`getVolume: pactl returned ${volume}%`);
        return volume;
      }
    } catch (e) {
      debugLog(`getVolume: pactl failed: ${e.message}`);
    }
    return -1;
  };

  /**
   * Set volume using PulseAudio/PipeWire (pactl)
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolumePulse = async (volume) => {
    if (!$) return false;
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await $`pactl set-sink-volume @DEFAULT_SINK@ ${clampedVolume}%`.quiet();
      debugLog(`setVolume: pactl set to ${clampedVolume}%`);
      return true;
    } catch (e) {
      debugLog(`setVolume: pactl failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Unmute using PulseAudio/PipeWire (pactl)
   * @returns {Promise<boolean>} Success status
   */
  const unmutePulse = async () => {
    if (!$) return false;
    try {
      await $`pactl set-sink-mute @DEFAULT_SINK@ 0`.quiet();
      debugLog('unmute: pactl succeeded');
      return true;
    } catch (e) {
      debugLog(`unmute: pactl failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Check if muted using PulseAudio/PipeWire
   * @returns {Promise<boolean|null>} True if muted, false if not, null if failed
   */
  const isMutedPulse = async () => {
    if (!$) return null;
    try {
      const result = await $`pactl get-sink-mute @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Output: "Mute: yes" or "Mute: no"
      return /yes|true/i.test(output);
    } catch (e) {
      debugLog(`isMuted: pactl failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // VOLUME CONTROL - ALSA (FALLBACK)
  // ============================================================

  /**
   * Get current volume using ALSA (amixer)
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getVolumeAlsa = async () => {
    if (!$) return -1;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Front Left: Playback 65536 [75%] [on]"
      const match = output.match(/\[(\d+)%\]/);
      if (match) {
        const volume = parseInt(match[1], 10);
        debugLog(`getVolume: amixer returned ${volume}%`);
        return volume;
      }
    } catch (e) {
      debugLog(`getVolume: amixer failed: ${e.message}`);
    }
    return -1;
  };

  /**
   * Set volume using ALSA (amixer)
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolumeAlsa = async (volume) => {
    if (!$) return false;
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await $`amixer set Master ${clampedVolume}%`.quiet();
      debugLog(`setVolume: amixer set to ${clampedVolume}%`);
      return true;
    } catch (e) {
      debugLog(`setVolume: amixer failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Unmute using ALSA (amixer)
   * @returns {Promise<boolean>} Success status
   */
  const unmuteAlsa = async () => {
    if (!$) return false;
    try {
      await $`amixer set Master unmute`.quiet();
      debugLog('unmute: amixer succeeded');
      return true;
    } catch (e) {
      debugLog(`unmute: amixer failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Check if muted using ALSA
   * @returns {Promise<boolean|null>} True if muted, false if not, null if failed
   */
  const isMutedAlsa = async () => {
    if (!$) return null;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Look for [off] or [mute] in output
      return /\[off\]|\[mute\]/i.test(output);
    } catch (e) {
      debugLog(`isMuted: amixer failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // UNIFIED VOLUME CONTROL (AUTO-DETECT BACKEND)
  // ============================================================

  /**
   * Get current system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getCurrentVolume = async () => {
    // Try PulseAudio/PipeWire first (most common on desktop Linux)
    let volume = await getVolumePulse();
    if (volume >= 0) return volume;
    
    // Fallback to ALSA
    volume = await getVolumeAlsa();
    return volume;
  };

  /**
   * Set system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolume = async (volume) => {
    // Try PulseAudio/PipeWire first
    if (await setVolumePulse(volume)) return true;
    
    // Fallback to ALSA
    return await setVolumeAlsa(volume);
  };

  /**
   * Unmute system audio
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<boolean>} Success status
   */
  const unmute = async () => {
    // Try PulseAudio/PipeWire first
    if (await unmutePulse()) return true;
    
    // Fallback to ALSA
    return await unmuteAlsa();
  };

  /**
   * Check if system audio is muted
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<boolean|null>} True if muted, false if not, null if detection failed
   */
  const isMuted = async () => {
    // Try PulseAudio/PipeWire first
    let muted = await isMutedPulse();
    if (muted !== null) return muted;
    
    // Fallback to ALSA
    return await isMutedAlsa();
  };

  /**
   * Force volume to maximum (unmute + set to 100%)
   * Used to ensure notifications are audible
   * @returns {Promise<boolean>} Success status
   */
  const forceVolume = async () => {
    const unmuted = await unmute();
    const volumeSet = await setVolume(100);
    return unmuted || volumeSet;
  };

  /**
   * Force volume if below threshold
   * @param {number} threshold - Minimum volume threshold (0-100)
   * @returns {Promise<boolean>} True if volume was forced, false if already adequate
   */
  const forceVolumeIfNeeded = async (threshold = 50) => {
    const currentVolume = await getCurrentVolume();
    
    // If we couldn't detect volume, force it to be safe
    if (currentVolume < 0) {
      debugLog('forceVolumeIfNeeded: could not detect volume, forcing');
      return await forceVolume();
    }
    
    // Check if already above threshold
    if (currentVolume >= threshold) {
      debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% >= ${threshold}%, no action needed`);
      return false;
    }
    
    // Force volume up
    debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% < ${threshold}%, forcing to 100%`);
    return await forceVolume();
  };

  // ============================================================
  // WSL2 SUPPORT
  // ============================================================
  
  /**
   * Detect if running in WSL2
   * @returns {boolean}
   */
  const isWSL2 = () => {
    try {
      const fs = require('fs');
      if (fs.existsSync('/proc/version')) {
        const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
        return version.includes('microsoft') && version.includes('wsl2');
      }
    } catch (e) {
      debugLog(`isWSL2: detection failed: ${e.message}`);
    }
    return false;
  };
  
  /**
   * Play audio file on Windows host via PowerShell (for WSL2)
   * Handles path conversion and file copying to Windows side for access
   * @param {string} filePath - WSL path to audio file
   * @returns {Promise<boolean>} Success status
   */
  cp "" ""`.quiet();
      
      debugLog(`playAudioWSL2: playing  via PowerShell MediaPlayer`);
      
      const psCommand = `
        Add-Type -AssemblyName PresentationCore;
         = New-Object System.Windows.Media.MediaPlayer;
        .Open((New-Object System.Uri ""));
         = 0;
        while (.NaturalDuration.HasTimeSpan -eq  -and  -lt 20) { Start-Sleep -Milliseconds 100; ++ }
         = 5;
        if (.NaturalDuration.HasTimeSpan) {  = .NaturalDuration.TimeSpan.TotalSeconds };
        .Play();
        Start-Sleep -Seconds ( + 1);
        .Close();
      `;
      
      await /**
 * Linux Platform Compatibility Module
 * 
 * Provides Linux-specific implementations for:
 * - Wake monitor from sleep (X11 and Wayland)
 * - Get current system volume (PulseAudio/PipeWire and ALSA)
 * - Force system volume up (PulseAudio/PipeWire and ALSA)
 * - Play audio files (PulseAudio and ALSA)
 * 
 * Dependencies (optional - graceful fallback if missing):
 * - x11-xserver-utils (for xset on X11)
 * - pulseaudio-utils or pipewire-pulse (for pactl)
 * - alsa-utils (for amixer, aplay, paplay)
 * 
 * @module util/linux
 */

/**
 * Creates a Linux platform utilities instance
 * @param {object} params - { $: shell runner, debugLog: logging function }
 * @returns {object} Linux platform API
 */
export const createLinuxPlatform = ({ $, debugLog = () => {} }) => {
  
  // ============================================================
  // DISPLAY SESSION DETECTION
  // ============================================================
  
  /**
   * Detect if running under Wayland
   * @returns {boolean}
   */
  const isWayland = () => {
    return !!process.env.WAYLAND_DISPLAY;
  };

  /**
   * Detect if running under X11
   * @returns {boolean}
   */
  const isX11 = () => {
    return !!process.env.DISPLAY && !isWayland();
  };

  /**
   * Get current session type
   * @returns {'x11' | 'wayland' | 'tty' | 'unknown'}
   */
  const getSessionType = () => {
    const sessionType = process.env.XDG_SESSION_TYPE;
    if (sessionType === 'x11' || sessionType === 'wayland' || sessionType === 'tty') {
      return sessionType;
    }
    if (isWayland()) return 'wayland';
    if (isX11()) return 'x11';
    return 'unknown';
  };

  // ============================================================
  // WAKE MONITOR
  // ============================================================

  /**
   * Wake monitor using X11 DPMS (works on X11 and often XWayland)
   * @returns {Promise<boolean>} Success status
   */
  const wakeMonitorX11 = async () => {
    if (!$) return false;
    try {
      await $`xset dpms force on`.quiet();
      debugLog('wakeMonitor: X11 xset dpms force on succeeded');
      return true;
    } catch (e) {
      debugLog(`wakeMonitor: X11 xset failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Wake monitor using GNOME D-Bus (for GNOME on Wayland)
   * Triggers a brightness step which wakes the display
   * @returns {Promise<boolean>} Success status
   */
  const wakeMonitorGnomeDBus = async () => {
    if (!$) return false;
    try {
      await $`gdbus call --session --dest org.gnome.SettingsDaemon.Power --object-path /org/gnome/SettingsDaemon/Power --method org.gnome.SettingsDaemon.Power.Screen.StepUp`.quiet();
      debugLog('wakeMonitor: GNOME D-Bus StepUp succeeded');
      return true;
    } catch (e) {
      debugLog(`wakeMonitor: GNOME D-Bus failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Wake monitor from sleep/DPMS standby
   * Tries multiple methods with graceful fallback:
   * 1. X11 xset (works on X11 and XWayland)
   * 2. GNOME D-Bus (works on GNOME Wayland)
   * 
   * @returns {Promise<boolean>} True if any method succeeded
   */
  const wakeMonitor = async () => {
    // Try X11 method first (most compatible, works on XWayland too)
    if (await wakeMonitorX11()) return true;
    
    // Try GNOME Wayland D-Bus method
    if (await wakeMonitorGnomeDBus()) return true;
    
    debugLog('wakeMonitor: all methods failed');
    return false;
  };

  // ============================================================
  // VOLUME CONTROL - PULSEAUDIO / PIPEWIRE
  // ============================================================

  /**
   * Get current volume using PulseAudio/PipeWire (pactl)
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getVolumePulse = async () => {
    if (!$) return -1;
    try {
      const result = await $`pactl get-sink-volume @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Volume: front-left: 65536 / 100% / 0.00 dB, ..."
      const match = output.match(/(\d+)%/);
      if (match) {
        const volume = parseInt(match[1], 10);
        debugLog(`getVolume: pactl returned ${volume}%`);
        return volume;
      }
    } catch (e) {
      debugLog(`getVolume: pactl failed: ${e.message}`);
    }
    return -1;
  };

  /**
   * Set volume using PulseAudio/PipeWire (pactl)
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolumePulse = async (volume) => {
    if (!$) return false;
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await $`pactl set-sink-volume @DEFAULT_SINK@ ${clampedVolume}%`.quiet();
      debugLog(`setVolume: pactl set to ${clampedVolume}%`);
      return true;
    } catch (e) {
      debugLog(`setVolume: pactl failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Unmute using PulseAudio/PipeWire (pactl)
   * @returns {Promise<boolean>} Success status
   */
  const unmutePulse = async () => {
    if (!$) return false;
    try {
      await $`pactl set-sink-mute @DEFAULT_SINK@ 0`.quiet();
      debugLog('unmute: pactl succeeded');
      return true;
    } catch (e) {
      debugLog(`unmute: pactl failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Check if muted using PulseAudio/PipeWire
   * @returns {Promise<boolean|null>} True if muted, false if not, null if failed
   */
  const isMutedPulse = async () => {
    if (!$) return null;
    try {
      const result = await $`pactl get-sink-mute @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Output: "Mute: yes" or "Mute: no"
      return /yes|true/i.test(output);
    } catch (e) {
      debugLog(`isMuted: pactl failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // VOLUME CONTROL - ALSA (FALLBACK)
  // ============================================================

  /**
   * Get current volume using ALSA (amixer)
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getVolumeAlsa = async () => {
    if (!$) return -1;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Front Left: Playback 65536 [75%] [on]"
      const match = output.match(/\[(\d+)%\]/);
      if (match) {
        const volume = parseInt(match[1], 10);
        debugLog(`getVolume: amixer returned ${volume}%`);
        return volume;
      }
    } catch (e) {
      debugLog(`getVolume: amixer failed: ${e.message}`);
    }
    return -1;
  };

  /**
   * Set volume using ALSA (amixer)
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolumeAlsa = async (volume) => {
    if (!$) return false;
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await $`amixer set Master ${clampedVolume}%`.quiet();
      debugLog(`setVolume: amixer set to ${clampedVolume}%`);
      return true;
    } catch (e) {
      debugLog(`setVolume: amixer failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Unmute using ALSA (amixer)
   * @returns {Promise<boolean>} Success status
   */
  const unmuteAlsa = async () => {
    if (!$) return false;
    try {
      await $`amixer set Master unmute`.quiet();
      debugLog('unmute: amixer succeeded');
      return true;
    } catch (e) {
      debugLog(`unmute: amixer failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Check if muted using ALSA
   * @returns {Promise<boolean|null>} True if muted, false if not, null if failed
   */
  const isMutedAlsa = async () => {
    if (!$) return null;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Look for [off] or [mute] in output
      return /\[off\]|\[mute\]/i.test(output);
    } catch (e) {
      debugLog(`isMuted: amixer failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // UNIFIED VOLUME CONTROL (AUTO-DETECT BACKEND)
  // ============================================================

  /**
   * Get current system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getCurrentVolume = async () => {
    // Try PulseAudio/PipeWire first (most common on desktop Linux)
    let volume = await getVolumePulse();
    if (volume >= 0) return volume;
    
    // Fallback to ALSA
    volume = await getVolumeAlsa();
    return volume;
  };

  /**
   * Set system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolume = async (volume) => {
    // Try PulseAudio/PipeWire first
    if (await setVolumePulse(volume)) return true;
    
    // Fallback to ALSA
    return await setVolumeAlsa(volume);
  };

  /**
   * Unmute system audio
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<boolean>} Success status
   */
  const unmute = async () => {
    // Try PulseAudio/PipeWire first
    if (await unmutePulse()) return true;
    
    // Fallback to ALSA
    return await unmuteAlsa();
  };

  /**
   * Check if system audio is muted
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<boolean|null>} True if muted, false if not, null if detection failed
   */
  const isMuted = async () => {
    // Try PulseAudio/PipeWire first
    let muted = await isMutedPulse();
    if (muted !== null) return muted;
    
    // Fallback to ALSA
    return await isMutedAlsa();
  };

  /**
   * Force volume to maximum (unmute + set to 100%)
   * Used to ensure notifications are audible
   * @returns {Promise<boolean>} Success status
   */
  const forceVolume = async () => {
    const unmuted = await unmute();
    const volumeSet = await setVolume(100);
    return unmuted || volumeSet;
  };

  /**
   * Force volume if below threshold
   * @param {number} threshold - Minimum volume threshold (0-100)
   * @returns {Promise<boolean>} True if volume was forced, false if already adequate
   */
  const forceVolumeIfNeeded = async (threshold = 50) => {
    const currentVolume = await getCurrentVolume();
    
    // If we couldn't detect volume, force it to be safe
    if (currentVolume < 0) {
      debugLog('forceVolumeIfNeeded: could not detect volume, forcing');
      return await forceVolume();
    }
    
    // Check if already above threshold
    if (currentVolume >= threshold) {
      debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% >= ${threshold}%, no action needed`);
      return false;
    }
    
    // Force volume up
    debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% < ${threshold}%, forcing to 100%`);
    return await forceVolume();
  };

  // ============================================================
  // WSL2 SUPPORT
  // ============================================================
  
  /**
   * Detect if running in WSL2
   * @returns {boolean}
   */
  const isWSL2 = () => {
    try {
      const fs = require('fs');
      if (fs.existsSync('/proc/version')) {
        const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
        return version.includes('microsoft') && version.includes('wsl2');
      }
    } catch (e) {
      debugLog(`isWSL2: detection failed: ${e.message}`);
    }
    return false;
  };
  
  /**
   * Play audio file on Windows host via PowerShell (for WSL2)
   * Handles path conversion and file copying to Windows side for access
   * @param {string} filePath - WSL path to audio file
   * @returns {Promise<boolean>} Success status
   */
  powershell.exe -c ""`.quiet();
      debugLog(`playAudioWSL2: playback finished`);
      
      /**
 * Linux Platform Compatibility Module
 * 
 * Provides Linux-specific implementations for:
 * - Wake monitor from sleep (X11 and Wayland)
 * - Get current system volume (PulseAudio/PipeWire and ALSA)
 * - Force system volume up (PulseAudio/PipeWire and ALSA)
 * - Play audio files (PulseAudio and ALSA)
 * 
 * Dependencies (optional - graceful fallback if missing):
 * - x11-xserver-utils (for xset on X11)
 * - pulseaudio-utils or pipewire-pulse (for pactl)
 * - alsa-utils (for amixer, aplay, paplay)
 * 
 * @module util/linux
 */

/**
 * Creates a Linux platform utilities instance
 * @param {object} params - { $: shell runner, debugLog: logging function }
 * @returns {object} Linux platform API
 */
export const createLinuxPlatform = ({ $, debugLog = () => {} }) => {
  
  // ============================================================
  // DISPLAY SESSION DETECTION
  // ============================================================
  
  /**
   * Detect if running under Wayland
   * @returns {boolean}
   */
  const isWayland = () => {
    return !!process.env.WAYLAND_DISPLAY;
  };

  /**
   * Detect if running under X11
   * @returns {boolean}
   */
  const isX11 = () => {
    return !!process.env.DISPLAY && !isWayland();
  };

  /**
   * Get current session type
   * @returns {'x11' | 'wayland' | 'tty' | 'unknown'}
   */
  const getSessionType = () => {
    const sessionType = process.env.XDG_SESSION_TYPE;
    if (sessionType === 'x11' || sessionType === 'wayland' || sessionType === 'tty') {
      return sessionType;
    }
    if (isWayland()) return 'wayland';
    if (isX11()) return 'x11';
    return 'unknown';
  };

  // ============================================================
  // WAKE MONITOR
  // ============================================================

  /**
   * Wake monitor using X11 DPMS (works on X11 and often XWayland)
   * @returns {Promise<boolean>} Success status
   */
  const wakeMonitorX11 = async () => {
    if (!$) return false;
    try {
      await $`xset dpms force on`.quiet();
      debugLog('wakeMonitor: X11 xset dpms force on succeeded');
      return true;
    } catch (e) {
      debugLog(`wakeMonitor: X11 xset failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Wake monitor using GNOME D-Bus (for GNOME on Wayland)
   * Triggers a brightness step which wakes the display
   * @returns {Promise<boolean>} Success status
   */
  const wakeMonitorGnomeDBus = async () => {
    if (!$) return false;
    try {
      await $`gdbus call --session --dest org.gnome.SettingsDaemon.Power --object-path /org/gnome/SettingsDaemon/Power --method org.gnome.SettingsDaemon.Power.Screen.StepUp`.quiet();
      debugLog('wakeMonitor: GNOME D-Bus StepUp succeeded');
      return true;
    } catch (e) {
      debugLog(`wakeMonitor: GNOME D-Bus failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Wake monitor from sleep/DPMS standby
   * Tries multiple methods with graceful fallback:
   * 1. X11 xset (works on X11 and XWayland)
   * 2. GNOME D-Bus (works on GNOME Wayland)
   * 
   * @returns {Promise<boolean>} True if any method succeeded
   */
  const wakeMonitor = async () => {
    // Try X11 method first (most compatible, works on XWayland too)
    if (await wakeMonitorX11()) return true;
    
    // Try GNOME Wayland D-Bus method
    if (await wakeMonitorGnomeDBus()) return true;
    
    debugLog('wakeMonitor: all methods failed');
    return false;
  };

  // ============================================================
  // VOLUME CONTROL - PULSEAUDIO / PIPEWIRE
  // ============================================================

  /**
   * Get current volume using PulseAudio/PipeWire (pactl)
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getVolumePulse = async () => {
    if (!$) return -1;
    try {
      const result = await $`pactl get-sink-volume @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Volume: front-left: 65536 / 100% / 0.00 dB, ..."
      const match = output.match(/(\d+)%/);
      if (match) {
        const volume = parseInt(match[1], 10);
        debugLog(`getVolume: pactl returned ${volume}%`);
        return volume;
      }
    } catch (e) {
      debugLog(`getVolume: pactl failed: ${e.message}`);
    }
    return -1;
  };

  /**
   * Set volume using PulseAudio/PipeWire (pactl)
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolumePulse = async (volume) => {
    if (!$) return false;
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await $`pactl set-sink-volume @DEFAULT_SINK@ ${clampedVolume}%`.quiet();
      debugLog(`setVolume: pactl set to ${clampedVolume}%`);
      return true;
    } catch (e) {
      debugLog(`setVolume: pactl failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Unmute using PulseAudio/PipeWire (pactl)
   * @returns {Promise<boolean>} Success status
   */
  const unmutePulse = async () => {
    if (!$) return false;
    try {
      await $`pactl set-sink-mute @DEFAULT_SINK@ 0`.quiet();
      debugLog('unmute: pactl succeeded');
      return true;
    } catch (e) {
      debugLog(`unmute: pactl failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Check if muted using PulseAudio/PipeWire
   * @returns {Promise<boolean|null>} True if muted, false if not, null if failed
   */
  const isMutedPulse = async () => {
    if (!$) return null;
    try {
      const result = await $`pactl get-sink-mute @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Output: "Mute: yes" or "Mute: no"
      return /yes|true/i.test(output);
    } catch (e) {
      debugLog(`isMuted: pactl failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // VOLUME CONTROL - ALSA (FALLBACK)
  // ============================================================

  /**
   * Get current volume using ALSA (amixer)
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getVolumeAlsa = async () => {
    if (!$) return -1;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Front Left: Playback 65536 [75%] [on]"
      const match = output.match(/\[(\d+)%\]/);
      if (match) {
        const volume = parseInt(match[1], 10);
        debugLog(`getVolume: amixer returned ${volume}%`);
        return volume;
      }
    } catch (e) {
      debugLog(`getVolume: amixer failed: ${e.message}`);
    }
    return -1;
  };

  /**
   * Set volume using ALSA (amixer)
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolumeAlsa = async (volume) => {
    if (!$) return false;
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await $`amixer set Master ${clampedVolume}%`.quiet();
      debugLog(`setVolume: amixer set to ${clampedVolume}%`);
      return true;
    } catch (e) {
      debugLog(`setVolume: amixer failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Unmute using ALSA (amixer)
   * @returns {Promise<boolean>} Success status
   */
  const unmuteAlsa = async () => {
    if (!$) return false;
    try {
      await $`amixer set Master unmute`.quiet();
      debugLog('unmute: amixer succeeded');
      return true;
    } catch (e) {
      debugLog(`unmute: amixer failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Check if muted using ALSA
   * @returns {Promise<boolean|null>} True if muted, false if not, null if failed
   */
  const isMutedAlsa = async () => {
    if (!$) return null;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Look for [off] or [mute] in output
      return /\[off\]|\[mute\]/i.test(output);
    } catch (e) {
      debugLog(`isMuted: amixer failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // UNIFIED VOLUME CONTROL (AUTO-DETECT BACKEND)
  // ============================================================

  /**
   * Get current system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<number>} Volume percentage (0-100) or -1 if failed
   */
  const getCurrentVolume = async () => {
    // Try PulseAudio/PipeWire first (most common on desktop Linux)
    let volume = await getVolumePulse();
    if (volume >= 0) return volume;
    
    // Fallback to ALSA
    volume = await getVolumeAlsa();
    return volume;
  };

  /**
   * Set system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @param {number} volume - Volume percentage (0-100)
   * @returns {Promise<boolean>} Success status
   */
  const setVolume = async (volume) => {
    // Try PulseAudio/PipeWire first
    if (await setVolumePulse(volume)) return true;
    
    // Fallback to ALSA
    return await setVolumeAlsa(volume);
  };

  /**
   * Unmute system audio
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<boolean>} Success status
   */
  const unmute = async () => {
    // Try PulseAudio/PipeWire first
    if (await unmutePulse()) return true;
    
    // Fallback to ALSA
    return await unmuteAlsa();
  };

  /**
   * Check if system audio is muted
   * Tries PulseAudio first, then falls back to ALSA
   * @returns {Promise<boolean|null>} True if muted, false if not, null if detection failed
   */
  const isMuted = async () => {
    // Try PulseAudio/PipeWire first
    let muted = await isMutedPulse();
    if (muted !== null) return muted;
    
    // Fallback to ALSA
    return await isMutedAlsa();
  };

  /**
   * Force volume to maximum (unmute + set to 100%)
   * Used to ensure notifications are audible
   * @returns {Promise<boolean>} Success status
   */
  const forceVolume = async () => {
    const unmuted = await unmute();
    const volumeSet = await setVolume(100);
    return unmuted || volumeSet;
  };

  /**
   * Force volume if below threshold
   * @param {number} threshold - Minimum volume threshold (0-100)
   * @returns {Promise<boolean>} True if volume was forced, false if already adequate
   */
  const forceVolumeIfNeeded = async (threshold = 50) => {
    const currentVolume = await getCurrentVolume();
    
    // If we couldn't detect volume, force it to be safe
    if (currentVolume < 0) {
      debugLog('forceVolumeIfNeeded: could not detect volume, forcing');
      return await forceVolume();
    }
    
    // Check if already above threshold
    if (currentVolume >= threshold) {
      debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% >= ${threshold}%, no action needed`);
      return false;
    }
    
    // Force volume up
    debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% < ${threshold}%, forcing to 100%`);
    return await forceVolume();
  };

  // ============================================================
  // WSL2 SUPPORT
  // ============================================================
  
  /**
   * Detect if running in WSL2
   * @returns {boolean}
   */
  const isWSL2 = () => {
    try {
      const fs = require('fs');
      if (fs.existsSync('/proc/version')) {
        const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
        return version.includes('microsoft') && version.includes('wsl2');
      }
    } catch (e) {
      debugLog(`isWSL2: detection failed: ${e.message}`);
    }
    return false;
  };
  
  /**
   * Play audio file on Windows host via PowerShell (for WSL2)
   * Handles path conversion and file copying to Windows side for access
   * @param {string} filePath - WSL path to audio file
   * @returns {Promise<boolean>} Success status
   */
  rm ""`.quiet().catch(e => debugLog(`playAudioWSL2: cleanup failed: `));
      return true;
    } catch (e) {
      debugLog(`playAudioWSL2: failed: `);
      return false;
    }
  };

  // ============================================================
  // AUDIO PLAYBACK
  // ============================================================

  /**
   * Play an audio file using PulseAudio (paplay)
   * @param {string} filePath - Path to audio file
   * @returns {Promise<boolean>} Success status
   */
  const playAudioPulse = async (filePath) => {
    if (!$) return false;
    try {
      await $`paplay ${filePath}`.quiet();
      debugLog(`playAudio: paplay succeeded for ${filePath}`);
      return true;
    } catch (e) {
      debugLog(`playAudio: paplay failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Play an audio file using ALSA (aplay)
   * Note: aplay only supports WAV files natively
   * @param {string} filePath - Path to audio file
   * @returns {Promise<boolean>} Success status
   */
  const playAudioAlsa = async (filePath) => {
    if (!$) return false;
    try {
      await $`aplay ${filePath}`.quiet();
      debugLog(`playAudio: aplay succeeded for ${filePath}`);
      return true;
    } catch (e) {
      debugLog(`playAudio: aplay failed: ${e.message}`);
      return false;
    }
  };

  /**
   * Play an audio file
   * Tries PulseAudio (paplay) first, then falls back to ALSA (aplay)
   * WSL2: Uses PowerShell bridge to Windows host audio
   * @param {string} filePath - Path to audio file
   * @param {number} loops - Number of times to play (default: 1)
   * @returns {Promise<boolean>} Success status
   */
  const playAudioFile = async (filePath, loops = 1) => {
    for (let i = 0; i < loops; i++) {
      // Check if running in WSL2 first
      if (isWSL2()) {
        debugLog('playAudioFile: WSL2 detected, using PowerShell bridge');
        if (await playAudioWSL2(filePath)) continue;
        debugLog('playAudioFile: WSL2 bridge failed, trying Linux audio tools');
      }
      
      // Try PulseAudio first (supports more formats including MP3)
      if (await playAudioPulse(filePath)) continue;
      
      // Fallback to ALSA
      if (await playAudioAlsa(filePath)) continue;
      
      // All methods failed
      debugLog(`playAudioFile: all methods failed for ${filePath}`);
      return false;
    }
    return true;
  };

  // ============================================================
  // PUBLIC API
  // ============================================================

  return {
    // Session detection
    isWayland,
    isX11,
    getSessionType,
    isWSL2,
    
    // Wake monitor
    wakeMonitor,
    wakeMonitorX11,
    wakeMonitorGnomeDBus,
    
    // Volume control (unified)
    getCurrentVolume,
    setVolume,
    unmute,
    isMuted,
    forceVolume,
    forceVolumeIfNeeded,
    
    // Volume control (specific backends)
    pulse: {
      getVolume: getVolumePulse,
      setVolume: setVolumePulse,
      unmute: unmutePulse,
      isMuted: isMutedPulse,
    },
    alsa: {
      getVolume: getVolumeAlsa,
      setVolume: setVolumeAlsa,
      unmute: unmuteAlsa,
      isMuted: isMutedAlsa,
    },
    
    // Audio playback
    playAudioWSL2,
    playAudioFile,
    playAudioPulse,
    playAudioAlsa,
  };
};
