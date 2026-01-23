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
    if (await wakeMonitorX11()) return true;
    if (await wakeMonitorGnomeDBus()) return true;
    debugLog('wakeMonitor: all methods failed');
    return false;
  };

  // ============================================================
  // VOLUME CONTROL - PULSEAUDIO / PIPEWIRE
  // ============================================================

  const getVolumePulse = async () => {
    if (!$) return -1;
    try {
      const result = await $`pactl get-sink-volume @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
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

  const isMutedPulse = async () => {
    if (!$) return null;
    try {
      const result = await $`pactl get-sink-mute @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      return /yes|true/i.test(output);
    } catch (e) {
      debugLog(`isMuted: pactl failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // VOLUME CONTROL - ALSA (FALLBACK)
  // ============================================================

  const getVolumeAlsa = async () => {
    if (!$) return -1;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
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

  const isMutedAlsa = async () => {
    if (!$) return null;
    try {
      const result = await $`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      return /\[off\]|\[mute\]/i.test(output);
    } catch (e) {
      debugLog(`isMuted: amixer failed: ${e.message}`);
      return null;
    }
  };

  // ============================================================
  // UNIFIED VOLUME CONTROL (AUTO-DETECT BACKEND)
  // ============================================================

  const getCurrentVolume = async () => {
    let volume = await getVolumePulse();
    if (volume >= 0) return volume;
    volume = await getVolumeAlsa();
    return volume;
  };

  const setVolume = async (volume) => {
    if (await setVolumePulse(volume)) return true;
    return await setVolumeAlsa(volume);
  };

  const unmute = async () => {
    if (await unmutePulse()) return true;
    return await unmuteAlsa();
  };

  const isMuted = async () => {
    let muted = await isMutedPulse();
    if (muted !== null) return muted;
    return await isMutedAlsa();
  };

  const forceVolume = async () => {
    const unmuted = await unmute();
    const volumeSet = await setVolume(100);
    return unmuted || volumeSet;
  };

  const forceVolumeIfNeeded = async (threshold = 50) => {
    const currentVolume = await getCurrentVolume();
    if (currentVolume < 0) {
      debugLog('forceVolumeIfNeeded: could not detect volume, forcing');
      return await forceVolume();
    }
    if (currentVolume >= threshold) {
      debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% >= ${threshold}%, no action needed`);
      return false;
    }
    debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% < ${threshold}%, forcing to 100%`);
    return await forceVolume();
  };

  // ============================================================
  // WSL2 SUPPORT
  // ============================================================
  
  const isWSL2 = () => {
    debugLog('DEBUG: isWSL2() called');
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
  
  const playAudioWSL2 = async (filePath) => {
    if (!$) return false;
    try {
      const path = require('path');
      const fileName = path.basename(filePath) || 'audio.mp3';
      const timestamp = Date.now();
      const tempFileName = `opencode-audio-${timestamp}-${fileName}`;
      const wslTempPath = `/mnt/c/Users/Public/${tempFileName}`;
      const windowsTempPath = `C:\\Users\\Public\\${tempFileName}`;
      
      debugLog(`playAudioWSL2: copying ${filePath} to ${wslTempPath}`);
      
      await $`cp "${filePath}" "${wslTempPath}"`.quiet();
      
      debugLog(`playAudioWSL2: playing ${windowsTempPath} via PowerShell MediaPlayer`);
      
      const psScript = `
        Add-Type -AssemblyName PresentationCore
        $player = New-Object System.Windows.Media.MediaPlayer
        $player.Open((New-Object System.Uri "${windowsTempPath}"))
        
        $waited = 0
        while ($player.NaturalDuration.HasTimeSpan -eq $false -and $waited -lt 20) { 
            Start-Sleep -Milliseconds 100
            $waited += 1
        }
        
        $duration = 5
        if ($player.NaturalDuration.HasTimeSpan) { 
            $duration = $player.NaturalDuration.TimeSpan.TotalSeconds 
        }
        
        $player.Play()
        Start-Sleep -Seconds ($duration + 1)
        $player.Close()
      `;

      const psBuffer = Buffer.from(psScript, 'utf16le');
      const psBase64 = psBuffer.toString('base64');
      
      await $`powershell.exe -EncodedCommand ${psBase64}`.quiet();
      
      debugLog(`playAudioWSL2: playback finished`);
      
      $`rm "${wslTempPath}"`.quiet().catch(e => debugLog(`playAudioWSL2: cleanup failed: ${e.message}`));
      
      return true;
    } catch (e) {
      debugLog(`playAudioWSL2: failed: ${e.message}`);
      if (e.stdout) debugLog(`stdout: ${e.stdout}`);
      if (e.stderr) debugLog(`stderr: ${e.stderr}`);
      return false;
    }
  };

  // ============================================================
  // AUDIO PLAYBACK
  // ============================================================

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

  const playAudioFile = async (filePath, loops = 1) => {
    debugLog(`DEBUG: playAudioFile called for ${filePath}`);
    for (let i = 0; i < loops; i++) {
      if (isWSL2()) {
        debugLog('playAudioFile: WSL2 detected, using PowerShell bridge');
        if (await playAudioWSL2(filePath)) continue;
        debugLog('playAudioFile: WSL2 bridge failed, trying Linux audio tools');
      }
      
      if (await playAudioPulse(filePath)) continue;
      if (await playAudioAlsa(filePath)) continue;
      
      debugLog(`playAudioFile: all methods failed for ${filePath}`);
      return false;
    }
    return true;
  };

  return {
    isWayland,
    isX11,
    getSessionType,
    isWSL2,
    wakeMonitor,
    wakeMonitorX11,
    wakeMonitorGnomeDBus,
    getCurrentVolume,
    setVolume,
    unmute,
    isMuted,
    forceVolume,
    forceVolumeIfNeeded,
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
    playAudioWSL2,
    playAudioFile,
    playAudioPulse,
    playAudioAlsa,
  };
};
