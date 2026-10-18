const path = require('path');
const { execFile, spawn } = require('child_process');

require('dotenv').config({
  path: path.join(__dirname, '.env')
});

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  MessageFlags
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  getVoiceConnection,
  StreamType
} = require('@discordjs/voice');

const play = require('play-dl');

const INTRO_PATH = path.join(__dirname, 'audio', 'Intro.wav');
const LOADING_PATH = path.join(__dirname, 'audio', 'loading.wav');

const YTDLP_PATH = process.env.YTDLP_PATH || (process.platform === 'win32'
  ? path.join(__dirname, 'yt-dlp.exe')
  : 'yt-dlp');

const FFMPEG_PATH = process.env.FFMPEG_PATH || (process.platform === 'win32'
  ? require('ffmpeg-static')
  : 'ffmpeg');

const YTMUSIC_PYTHON_PATH = process.env.YTMUSIC_PYTHON_PATH ||
  (process.platform === 'win32' ? 'python' : 'python3');

const DENO_PATH = process.env.DENO_PATH || 'deno';
const YTDLP_JS_RUNTIME = DENO_PATH === 'deno'
  ? 'deno'
  : `deno:${DENO_PATH}`;
const YTMUSIC_RADIO_SCRIPT = path.join(__dirname, 'ytmusic_radio.py');
const YTMUSIC_RADIO_TIMEOUT_MS = 15000;
const MAX_RADIO_PREFETCH = 8;

const CONTROL_IDS = {
  playPause: 'dj-peligro:play-pause',
  stop: 'dj-peligro:stop',
  next: 'dj-peligro:next',
  previous: 'dj-peligro:previous'
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const player = createAudioPlayer();
const loadingPlayer = createAudioPlayer();

const loadingCueState = {
  active: false,
  connection: null,
  generation: 0
};
let lastIntroDate = null;
let currentSong = null;
let isPaused = false;
let controlsMessage = null;
let controlsChannelId = null;
let isSkipping = false;
let isStopping = false;
let isGoingPrevious = false;
let isStarting = false;
let isAdvancing = false;
let playingIntro = false;
let activePlayback = null;
let playbackSequence = 0;
let pendingIdleAdvance = null;
const transportPreloadBuffer = {
  generation: 0,
  entriesByKey: new Map(),
  order: [],
  activeKey: null,
  activePromise: null
};
const recentTransportCache = new Map();
let foregroundTransportResolutionInProgress = false;
let foregroundTransportResolutionGeneration = 0;
let foregroundTransportController = null;
const FOREGROUND_TRANSPORT_CANCELLED_CODE = 'FOREGROUND_TRANSPORT_CANCELLED';
let pendingPostPreviousNextSong = null;
let currentRadioPreload = null;
let currentRadioRefill = null;

const transportRefreshState = {
  activePromise: null,
  controller: null,
  key: null,
  startedAt: null,
  timer: null,
  enabled: false
};
let radioPreloadGeneration = 0;
let verifiedRadioFillInProgress = false;
let verifiedRadioFillTimer = null;
const manualQueue = [];
const radioQueue = [];
const verifiedRadioQueue = [];
const history = [];
const forwardStack = [];
let sessionMessageRefs = [];
let commandMessageRefs = [];
let controlMessageRefs = [];
let controlsMutationPromise = Promise.resolve();
let inactivityTimer = null;
let voiceEmptyTimer = null;
let activeGuildId = null;
let lastManualSong = null;
let radioSeedSong = null;
let radioMode = true;
let radioCount = 0;
let consecutiveRadioFailures = 0;
let lastRadioArtistKey = null;
let radioArtistStreak = 0;
const playedUrls = new Set();
const playedTitleKeys = new Set();
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const VOICE_EMPTY_TIMEOUT_MS = 120 * 1000;
const MAX_RADIO_SONGS = 25;
const VERIFIED_RADIO_QUEUE_MAX = 2;
const TRANSPORT_VERIFIER_PROBE_SECONDS = 2;
const TRANSPORT_VERIFIER_TIMEOUT_MS = 8000;
const MAX_CONSECUTIVE_RADIO_FAILURES = 3;
const RADIO_QUEUE_REFILL_THRESHOLD = 2;
const MIN_VALID_PLAYBACK_MS = 3000;
const MAX_YOUTUBE_TRANSPORT_RETRIES = 1;
const YOUTUBE_TRANSPORT_RETRY_EARLY_MS = 30_000;
const DEFAULT_YTDLP_FORMAT_SELECTOR = 'bestaudio';
const M4A_RETRY_FORMAT_SELECTOR = '140/139/bestaudio[ext=m4a]';
const TRANSPORT_SOFT_REFRESH_MS = 5 * 60_000;
const TRANSPORT_PRELOAD_TTL_MS = 15 * 60_000;
const TRANSPORT_PRELOAD_BUFFER_MAX = 2;
const RECENT_TRANSPORT_CACHE_TTL_MS = 15 * 60_000;

// Navigation policy:
// Keep a long song history, but only keep a small hot window of transports fresh.
const NAV_HISTORY_MAX = 30;
const NAV_FORWARD_MAX = 10;
const HOT_BACK_TRANSPORTS_MAX = 3;
const HOT_FORWARD_TRANSPORTS_MAX = 5;
const PREPARED_RADIO_TRANSPORTS_MAX = TRANSPORT_PRELOAD_BUFFER_MAX;
const RECENT_TRANSPORT_CACHE_MAX =
  HOT_BACK_TRANSPORTS_MAX + HOT_FORWARD_TRANSPORTS_MAX + PREPARED_RADIO_TRANSPORTS_MAX;

function playLoadingCueIteration(generation) {
  if (
    !loadingCueState.active ||
    loadingCueState.generation !== generation
  ) {
    return false;
  }

  try {
    const resource = createAudioResource(LOADING_PATH);
    loadingPlayer.play(resource);
    return true;
  } catch (error) {
    console.warn(
      `[loading-cue] No se pudo crear loading.wav: ${sanitizeDiagnosticText(error)}`
    );
    stopLoadingCue('resource-error');
    return false;
  }
}

function startLoadingCue(connection, reason = 'foreground-resolve') {
  if (!connection || loadingCueState.active) return false;

  // Loading nunca debe interrumpir una cancion real.
  // Excepcion segura: una radio ya marcada para apagarse por pedido manual.
  const yieldingManualOverRadio = Boolean(
    activePlayback?.expectedShutdown &&
    activePlayback?.expectedShutdownReason === 'pedido manual sobre radio'
  );

  if (
    player.state.status !== AudioPlayerStatus.Idle &&
    !yieldingManualOverRadio
  ) {
    console.log(
      `[loading-cue] Omitido: main player no puede ceder audio, reason=${reason}`
    );
    return false;
  }

  const generation = ++loadingCueState.generation;

  loadingCueState.active = true;
  loadingCueState.connection = connection;

  try {
    connection.subscribe(loadingPlayer);
    playLoadingCueIteration(generation);
    updateControlsMessage().catch(console.error);

    console.log(
      `[loading-cue] Activado: reason=${reason}, generation=${generation}`
    );
    return true;
  } catch (error) {
    loadingCueState.active = false;
    loadingCueState.connection = null;

    console.warn(
      `[loading-cue] No se pudo activar: ${sanitizeDiagnosticText(error)}`
    );
    return false;
  }
}

function stopLoadingCue(reason = 'transport-ready', restoreMainPlayer = true) {
  if (!loadingCueState.active) return false;

  const connection = loadingCueState.connection;

  loadingCueState.active = false;
  loadingCueState.connection = null;

  // Invalida cualquier Idle pendiente de una iteracion anterior.
  loadingCueState.generation += 1;

  loadingPlayer.stop(true);

  if (restoreMainPlayer && connection) {
    try {
      connection.subscribe(player);
    } catch (error) {
      console.warn(
        `[loading-cue] No se pudo restaurar main player: ${sanitizeDiagnosticText(error)}`
      );
    }
  }

  console.log(`[loading-cue] Desactivado: reason=${reason}`);
  updateControlsMessage().catch(console.error);
  return true;
}

loadingPlayer.on(AudioPlayerStatus.Idle, () => {
  if (!loadingCueState.active) return;

  const generation = loadingCueState.generation;

  setImmediate(() => {
    playLoadingCueIteration(generation);
  });
});

loadingPlayer.on('error', (error) => {
  console.warn(
    `[loading-cue] Audio player error: ${sanitizeDiagnosticText(error)}`
  );
  stopLoadingCue('player-error');
});

player.on('error', (error) => {
  console.error('Audio player error:', error);

  if (activePlayback) {
    activePlayback.playerError = error;
  }
});

player.on(AudioPlayerStatus.Playing, () => {
  isPaused = false;

  const resource = player.state.resource;
  if (activePlayback?.resource === resource && !activePlayback.startedAt) {
    activePlayback.startedAt = Date.now();

    if (activePlayback.transportRetryCount > 0) {
      console.log(
        `[transport-retry] Retry alcanzo estado Playing. ` +
        `attempt=${activePlayback.transportRetryCount}/${MAX_YOUTUBE_TRANSPORT_RETRIES}.`
      );
    }
  }

  const title = activePlayback?.song?.title || activePlayback?.song?.url || 'recurso sin titulo';
  console.log(`Reproduciendo audio: ${title}`);
  if (activePlayback?.song) clearPanelNotice();
  if (foregroundTransportResolutionInProgress) {
    foregroundTransportResolutionInProgress = false;
  }
  reconcileTransportPreloadBuffer('playback-playing');
  startRadioPreloadForManualSong(activePlayback?.song);

  transportRefreshState.enabled = true;
  scheduleTransportRefresh('playback-playing');

  updateControlsMessage().catch(console.error);
});

player.on(AudioPlayerStatus.Paused, () => {
  isPaused = true;
  console.log('Audio pausado.');
  updateControlsMessage().catch(console.error);
});

player.on(AudioPlayerStatus.Idle, (oldState) => {
  if (playingIntro) {
    console.log('Intro terminada.');
    return;
  }

  const resource = oldState?.resource || null;
  const playback = activePlayback?.resource === resource
    ? activePlayback
    : resource?.metadata?.playback || null;

  if (!playback || activePlayback?.id !== playback.id) {
    console.log('Idle ignorado para recurso anterior o sin playback activo.');
    return;
  }

  if (playback.expectedShutdown || playback.ffmpegState?.expectedShutdown) {
    console.log(
      `Idle esperado por ${playback.expectedShutdownReason ||
        playback.ffmpegState?.expectedShutdownReason || 'control manual'}. ` +
      'No reintento ni avanzo automaticamente.'
    );
    activePlayback = null;
    updateControlsMessage().catch(console.error);
    return;
  }

  const playedMs = playback.startedAt ? Date.now() - playback.startedAt : 0;
  const ffmpegFailed = Boolean(
    playback.ffmpegState?.closed &&
    playback.ffmpegState.exitCode !== null &&
    playback.ffmpegState.exitCode !== 0
  );
  const endedBeforeAudio = !playback.startedAt;
  const endedTooSoonAfterFfmpegError = ffmpegFailed && playedMs < MIN_VALID_PLAYBACK_MS;
  const affectedSong = playback.song || null;
  const title = affectedSong?.title || affectedSong?.url || 'cancion sin titulo';

  if (playback.playerError || ffmpegFailed || endedBeforeAudio || endedTooSoonAfterFfmpegError) {
    const failureReason = sanitizeDiagnosticText(playback.playerError?.message ||
      playback.ffmpegState?.stderr?.trim() ||
      'La reproduccion termino con error.');

    console.error(
      `Playback fallo antes de terminar normalmente: ${title}. ` +
      `playedMs=${playedMs}, ffmpegCode=${playback.ffmpegState?.exitCode ?? 'n/a'}`
    );

    activePlayback = null;
    currentSong = null;

    if (isAdvancing || isStarting) {
      pendingIdleAdvance = {
        kind: 'playback-attempt-failed',
        song: affectedSong,
        reason: failureReason,
        playedMs,
        transportRetryCount: playback.transportRetryCount,
        transportFormat: playback.transportFormat
      };
      console.log('Avance diferido tras fallo de playback durante preparacion/cambio.');
      return;
    }

    handlePlaybackAttemptFailure(
      affectedSong,
      failureReason,
      playedMs,
      playback.transportRetryCount,
      playback.transportFormat
    ).catch((error) => {
      console.error('Error manejando fallo de playback:', sanitizeDiagnosticText(error));
    });
    return;
  }

  console.log(`Audio terminado: ${title} (${Math.round(playedMs / 1000)}s).`);

  if (playback.transportRetryCount > 0) {
    console.log(
      `[transport-retry] Retry terminado normalmente. ` +
      `attempt=${playback.transportRetryCount}/${MAX_YOUTUBE_TRANSPORT_RETRIES}.`
    );
  }

  activePlayback = null;

  if (affectedSong?.source === 'radio') {
    consecutiveRadioFailures = 0;
  }

  if (isAdvancing || isStarting) {
    pendingIdleAdvance = {
      kind: 'playback-ended',
      pushCurrentToHistory: true,
      song: affectedSong,
      reason: 'playback-ended'
    };
    console.log('Avance diferido tras fin de playback durante preparacion/cambio.');
    return;
  }

  playNextSong({ pushCurrentToHistory: true }).catch((error) => {
    console.error('Error al avanzar la cola:', error);
  });
});

client.once('clientReady', () => {
  console.log(`DJ Peligro listo como ${client.user.tag}`);
});

const INSTALL_WELCOME_MESSAGE = [
  '*En un canal de voz:*',
  'Escribí `Play` seguido de un enlace de YouTube.',
  'Powered by **SYNC.dll**'
].join('\n');

async function sendInstallWelcome(guild) {
  const candidates = [];

  if (guild.systemChannel?.isTextBased?.() && typeof guild.systemChannel.send === 'function') {
    candidates.push(guild.systemChannel);
  }

  const fallbackChannels = guild.channels.cache
    .filter((channel) => channel.isTextBased?.() && typeof channel.send === 'function')
    .sort((a, b) => a.rawPosition - b.rawPosition);

  for (const channel of fallbackChannels.values()) {
    if (!candidates.some((candidate) => candidate.id === channel.id)) {
      candidates.push(channel);
    }
  }

  for (const channel of candidates) {
    try {
      await channel.send({
        content: INSTALL_WELCOME_MESSAGE,
        flags: MessageFlags.SuppressNotifications
      });

      console.log(`Mensaje de instalacion enviado en ${guild.name} (#${channel.name}).`);
      return;
    } catch (error) {
      console.warn(`No pude enviar mensaje de instalacion en #${channel.name}: ${error.message}`);
    }
  }

  console.warn(`No encontre un canal escribible para el mensaje de instalacion en ${guild.name}.`);
}

client.on('guildCreate', (guild) => {
  sendInstallWelcome(guild).catch((error) => {
    console.error('Error enviando mensaje de instalacion:', error);
  });
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', sanitizeDiagnosticText(reason));
});

function sanitizeDiagnosticText(value) {
  return String(value?.stack || value?.message || value || '')
    .replace(/https?:\/\/[^\s"'<>]*googlevideo\.com\/videoplayback[^\s"'<>]*/gi, '[googlevideo-url-redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      const cleanUrl = url.replace(/[),.;]+$/, '');
      const suffix = url.slice(cleanUrl.length);

      if (/^https?:\/\/(?:www\.|music\.)?youtube\.com\/watch\?v=[\w-]+$/i.test(cleanUrl) ||
          /^https?:\/\/youtu\.be\/[\w-]+$/i.test(cleanUrl)) {
        return `${cleanUrl}${suffix}`;
      }

      if (cleanUrl.length >= 120 || /[?&](?:sig|lsig|spc|ip|expire)=/i.test(cleanUrl)) {
        return `[url-redacted]${suffix}`;
      }

      return `${cleanUrl}${suffix}`;
    });
}

async function playIntroIfNeeded() {
  const today = new Date().toDateString();

  if (lastIntroDate === today) return;

  lastIntroDate = today;
  playingIntro = true;
  updateControlsMessage().catch(console.error);

  try {
    const introResource = createAudioResource(INTRO_PATH);
    player.play(introResource);
    await entersState(player, AudioPlayerStatus.Idle, 10 * 60_000);
  } finally {
    playingIntro = false;
    updateControlsMessage().catch(console.error);
  }
}

function formatSong(song, index = null) {
  if (!song) return 'Nada';
  const prefix = index === null ? '' : `${index}. `;
  return `${prefix}${song.title || song.url}`;
}

let panelNotice = null;
let panelNoticeTimer = null;

function buildControlsContent() {
  if (panelNotice) return panelNotice;
  if (playingIntro) return 'Starting...';

  if (
    loadingCueState.active ||
    ((isStarting || isAdvancing) &&
      player.state.status === AudioPlayerStatus.Idle)
  ) {
    return 'Loading...';
  }

  if (currentSong && currentSong.title) {
    return `Playing: ${currentSong.title}`;
  }

  return '\u200B';
}

function buildControlsRow() {
  const playPauseSymbol = isPaused ? '▶' : 'Ⅱ';
  const hasActivePlayback = Boolean(currentSong) ||
    manualQueue.length > 0 ||
    radioQueue.length > 0 ||
    player.state.status !== AudioPlayerStatus.Idle ||
    isStarting;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CONTROL_IDS.previous)
      .setLabel('⏮')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!history.length),
    new ButtonBuilder()
      .setCustomId(CONTROL_IDS.playPause)
      .setLabel(playPauseSymbol)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasActivePlayback),
    new ButtonBuilder()
      .setCustomId(CONTROL_IDS.next)
      .setLabel('⏭')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!currentSong && !manualQueue.length && !radioQueue.length),
    new ButtonBuilder()
      .setCustomId(CONTROL_IDS.stop)
      .setLabel('■')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(false),
  );
}

function createMessageRef(message) {
  if (!message?.id || !message?.channel?.id) return null;

  return {
    channelId: message.channel.id,
    messageId: message.id
  };
}

function refsAreSame(firstRef, secondRef) {
  return Boolean(
    firstRef &&
    secondRef &&
    firstRef.channelId === secondRef.channelId &&
    firstRef.messageId === secondRef.messageId
  );
}

function refsHaveMessage(refs, ref) {
  return refs.some((storedRef) => refsAreSame(storedRef, ref));
}

function rememberMessageRef(refs, message) {
  const ref = createMessageRef(message);
  if (!ref || refsHaveMessage(refs, ref)) return refs;

  refs.push(ref);
  return refs;
}

function rememberSessionMessage(message) {
  sessionMessageRefs = rememberMessageRef(sessionMessageRefs, message);
}

function rememberCommandMessage(message) {
  commandMessageRefs = rememberMessageRef(commandMessageRefs, message);
}

function rememberControlMessage(message) {
  controlMessageRefs = rememberMessageRef(controlMessageRefs, message);
}

async function runControlsMutation(operation) {
  const previousMutation = controlsMutationPromise;
  let releaseMutation;

  controlsMutationPromise = new Promise((resolve) => {
    releaseMutation = resolve;
  });

  await previousMutation.catch(() => {});

  try {
    return await operation();
  } finally {
    releaseMutation();
  }
}

function isUnknownInteractionError(error) {
  return error?.code === 10062 ||
    error?.rawError?.code === 10062 ||
    /Unknown interaction/i.test(error?.message || '');
}

function isUnknownMessageError(error) {
  return error?.code === 10008 ||
    error?.rawError?.code === 10008 ||
    /Unknown Message/i.test(error?.message || '');
}

async function deleteMessageByRef(ref) {
  if (!ref?.channelId || !ref?.messageId) return;

  try {
    const channel = await client.channels.fetch(ref.channelId).catch(() => null);
    if (!channel?.messages?.fetch) return;

    const message = await channel.messages.fetch(ref.messageId).catch(() => null);
    if (!message) return;

    await message.delete().catch(() => {});
  } catch {
  }
}

async function getControlsChannel(fallbackChannel = null) {
  if (fallbackChannel) return fallbackChannel;
  if (controlsMessage?.channel) return controlsMessage.channel;
  if (!controlsChannelId) return null;

  return client.channels.fetch(controlsChannelId).catch(() => null);
}

async function fetchControlsMessage() {
  if (!controlsMessage?.id) return null;

  const channel = await getControlsChannel();
  if (!channel?.messages?.fetch) {
    controlsMessage = null;
    return null;
  }

  try {
    const message = await channel.messages.fetch(controlsMessage.id);
    controlsMessage = message;
    controlsChannelId = message.channel.id;
    rememberControlMessage(message);
    return message;
  } catch (error) {
    if (isUnknownMessageError(error)) {
      console.warn('Mensaje de controles inexistente. Limpio referencia.');
      controlsMessage = null;
      return null;
    }

    console.warn('No pude verificar el mensaje de controles:', error.message);
    return null;
  }
}

async function deleteControlMessagesUnlocked({ keepMessage = null } = {}) {
  const keepRef = createMessageRef(keepMessage);
  const refsToDelete = [...controlMessageRefs];

  if (controlsMessage) {
    const currentRef = createMessageRef(controlsMessage);

    if (currentRef && !refsHaveMessage(refsToDelete, currentRef)) {
      refsToDelete.push(currentRef);
    }
  }

  controlsMessage = keepMessage || null;
  controlMessageRefs = keepRef ? [keepRef] : [];

  if (keepMessage?.channel?.id) {
    controlsChannelId = keepMessage.channel.id;
  }

  for (const ref of refsToDelete) {
    if (keepRef && refsAreSame(ref, keepRef)) continue;
    await deleteMessageByRef(ref);
  }
}

async function sendOrUpdateControls(channel, { repost = false } = {}) {
  return runControlsMutation(async () => {
    const payload = {
      content: buildControlsContent(),
      components: [buildControlsRow()]
    };

    controlsChannelId = channel?.id || controlsChannelId;

    if (repost) {
      await deleteControlMessagesUnlocked();
    }

    const existingControlsMessage = await fetchControlsMessage();

    if (existingControlsMessage) {
      try {
        controlsMessage = await existingControlsMessage.edit(payload);
        controlsChannelId = controlsMessage.channel.id;
        rememberControlMessage(controlsMessage);
        await deleteControlMessagesUnlocked({ keepMessage: controlsMessage });
        return controlsMessage;
      } catch (error) {
        if (isUnknownMessageError(error)) {
          console.warn('Mensaje de controles ya fue borrado. Creo uno nuevo.');
        } else {
          console.error('No pude editar el mensaje de controles, creando uno nuevo:', error.message);
        }

        controlsMessage = null;
      }
    }

    await deleteControlMessagesUnlocked();

    controlsMessage = await channel.send({
      ...payload,
      flags: MessageFlags.SuppressNotifications
    });
    controlsChannelId = controlsMessage.channel.id;
    rememberControlMessage(controlsMessage);
    return controlsMessage;
  });
}

async function repostControlsMessage(channel = null) {
  const targetChannel = await getControlsChannel(channel);
  if (!targetChannel) return null;

  return sendOrUpdateControls(targetChannel, { repost: true });
}

async function updateControlsMessage() {
  return runControlsMutation(async () => {
    const existingControlsMessage = await fetchControlsMessage();
    if (!existingControlsMessage) return;

    try {
      controlsMessage = await existingControlsMessage.edit({
        content: buildControlsContent(),
        components: [buildControlsRow()]
      });
      controlsChannelId = controlsMessage.channel.id;
      rememberControlMessage(controlsMessage);
      await deleteControlMessagesUnlocked({ keepMessage: controlsMessage });
    } catch (error) {
      if (isUnknownMessageError(error)) {
        console.warn('No pude editar controles porque el mensaje ya no existe.');
      } else {
        console.error('No pude editar el mensaje de controles:', error.message);
      }

      controlsMessage = null;
    }
  });
}

async function deleteControlsMessage() {
  return runControlsMutation(async () => {
    await deleteControlMessagesUnlocked();
  });
}

function clearInactivityTimer() {
  if (!inactivityTimer) return;

  clearTimeout(inactivityTimer);
  inactivityTimer = null;
}

function clearVoiceEmptyTimer() {
  if (!voiceEmptyTimer) return;

  clearTimeout(voiceEmptyTimer);
  voiceEmptyTimer = null;
}

function getCurrentVoiceChannel(guildId) {
  const connection = guildId ? getVoiceConnection(guildId) : null;
  const voiceChannelId = connection?.joinConfig?.channelId;

  if (!voiceChannelId) return null;

  const guild = client.guilds.cache.get(guildId);
  return guild?.channels.cache.get(voiceChannelId) || null;
}

function isBotAloneInVoiceChannel(guildId) {
  const channel = getCurrentVoiceChannel(guildId);
  if (!channel?.members) return false;

  const humanListeners = channel.members.filter((member) => !member.user.bot).size;
  return humanListeners === 0;
}

function startVoiceEmptyTimer(guildId) {
  if (!guildId || voiceEmptyTimer) return;

  console.log('El bot quedo solo en voice. Iniciando timer corto de limpieza.');

  voiceEmptyTimer = setTimeout(async () => {
    voiceEmptyTimer = null;

    if (!isBotAloneInVoiceChannel(guildId)) {
      console.log('Volvio gente al canal. No se limpia la sesion.');
      return;
    }

    console.log('El bot sigue solo en voice. Limpiando sesion.');
    await cleanupSession(guildId).catch((error) => {
      console.error('Error limpiando sesion por canal vacio:', error);
    });
  }, VOICE_EMPTY_TIMEOUT_MS);
}

function startInactivityTimer(guildId) {
  if (!guildId) return;

  clearInactivityTimer();

  inactivityTimer = setTimeout(async () => {
    console.log('Inactivity timeout reached. Cleaning session...');

    await cleanupSession(guildId).catch((error) => {
      console.error('Error limpiando sesion por inactividad:', error);
    });
  }, INACTIVITY_TIMEOUT_MS);

  console.log('Timer de inactividad iniciado.');
}

function getCleanupGuildId(guildId) {
  return guildId || activeGuildId || controlsMessage?.guildId || null;
}

function hasActiveSession() {
  return Boolean(currentSong) ||
    manualQueue.length > 0 ||
    radioQueue.length > 0 ||
    history.length > 0 ||
    forwardStack.length > 0 ||
    controlsMessage ||
    player.state.status !== AudioPlayerStatus.Idle ||
    isStarting ||
    playingIntro;
}

async function cleanupSessionMessages() {
  await deleteControlsMessage();

  const refsToDelete = [
    ...sessionMessageRefs,
    ...commandMessageRefs
  ];

  for (const ref of refsToDelete) {
    await deleteMessageByRef(ref);
  }

  sessionMessageRefs = [];
  commandMessageRefs = [];
  controlMessageRefs = [];
  controlsMessage = null;
  controlsChannelId = null;
}

async function cleanupSession(guildId) {
  const cleanupGuildId = getCleanupGuildId(guildId);

  console.log('Limpiando sesion completa...');

  stopLoadingCue('stop/cleanup', false);

  transportRefreshState.enabled = false;
  cancelTransportRefresh('stop/cleanup');

  cancelRadioPreload('stop/cleanup');
  cancelRadioQueueRefill('stop/cleanup');
  cancelTransportPreload('stop/cleanup');
  clearRecentTransportCache('stop/cleanup');
  cancelForegroundTransportResolution('stop/cleanup');
  clearForwardStack('stop/cleanup');

  clearInactivityTimer();
  clearVoiceEmptyTimer();
  clearPanelNotice();

  isStopping = true;
  markActivePlaybackExpectedShutdown('stop/cleanup');
  isAdvancing = false;
  manualQueue.length = 0;
  radioQueue.length = 0;
  history.length = 0;
  currentSong = null;
  lastManualSong = null;
  radioSeedSong = null;
  radioMode = true;
  radioCount = 0;
  consecutiveRadioFailures = 0;
  lastRadioArtistKey = null;
  radioArtistStreak = 0;
  playedUrls.clear();
  playedTitleKeys.clear();
  isPaused = false;
  isStarting = false;
  activePlayback = null;
  pendingIdleAdvance = null;

  player.stop(true);

  const connection = cleanupGuildId ? getVoiceConnection(cleanupGuildId) : null;
  if (connection) {
    connection.destroy();
  }

  await cleanupSessionMessages();

  activeGuildId = null;
  isStopping = false;

  console.log('Sesion limpia.');
}

function clearPanelNotice() {
  if (panelNoticeTimer) clearTimeout(panelNoticeTimer);
  panelNoticeTimer = null;
  panelNotice = null;
}

async function showPanelNotice(content, fallbackChannel = null) {
  const existing = await fetchControlsMessage();

  if (!existing) {
    return fallbackChannel
      ? sendQuietNotice(fallbackChannel, content)
      : null;
  }

  const isError = content === 'Playback failed.' ||
    content === 'Action failed.';

  const previousIsError = panelNotice === 'Playback failed.' ||
    panelNotice === 'Action failed.';

  if (previousIsError && !isError) {
    return updateControlsMessage();
  }

  clearPanelNotice();
  panelNotice = content;

  if (!isError) {
    panelNoticeTimer = setTimeout(() => {
      panelNotice = null;
      panelNoticeTimer = null;
      updateControlsMessage().catch(console.error);
    }, 5000);
  }

  return updateControlsMessage();
}

async function sendQuietNotice(channel, content) {
  const message = await channel.send({
    content,
    flags: MessageFlags.SuppressNotifications
  }).catch((error) => {
    console.error('No pude enviar aviso:', error);
  });

  rememberSessionMessage(message);
  return message;
}

async function sendEphemeralNotice(interaction, content) {
  if (await fetchControlsMessage()) {
    return showPanelNotice(content);
  }

  return interaction.followUp({
    content,
    flags: MessageFlags.Ephemeral
  }).catch((error) => {
    if (isUnknownInteractionError(error)) {
      console.warn('No pude enviar aviso ephemeral porque la interaccion expiro.');
      return;
    }

    console.error('No pude enviar aviso ephemeral:', error);
  });
}

function extractPlayUrl(content) {
  if (!content.toLowerCase().startsWith('play')) return null;

  const afterPlay = content.slice(4).trim();
  const match = afterPlay.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}

function isPlayerBusy() {
  return player.state.status === AudioPlayerStatus.Playing ||
    player.state.status === AudioPlayerStatus.Paused ||
    loadingCueState.active ||
    currentSong !== null ||
    isStarting ||
    playingIntro;
}

function clearManualPlaybackFlags() {
  isSkipping = false;
  isStopping = false;
  isGoingPrevious = false;
}

function normalizeSongTitle(title) {
  return (title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\b(official video|official audio|music video|lyric video|lyrics?|visualizer|remaster(?:ed)?|extended|cover|version|edit|official|video|audio|live|hd|4k)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getDurationSeconds(result) {
  if (typeof result?.durationInSec === 'number') return result.durationInSec;
  if (typeof result?.durationInSeconds === 'number') return result.durationInSeconds;
  if (typeof result?.duration === 'number') return result.duration;
  if (typeof result?.durationRaw !== 'string') return null;

  const parts = result.durationRaw.split(':').map((part) => Number(part));
  if (parts.some(Number.isNaN)) return null;

  return parts.reduce((total, part) => total * 60 + part, 0);
}

function looksLikeLongFormRadioResult(title) {
  return /\b(full concert|full show|live at|lollapalooza|festival|set|session|tiny desk|boiler room|en vivo|ao vivo|cover|extended)\b/i.test(title || '');
}

function isPreferredRadioResult(title) {
  return /\b(official audio|official video|topic|audio)\b/i.test(title || '');
}

function titleKeysAreTooSimilar(titleKey, baseTitleKey) {
  if (!titleKey || !baseTitleKey) return false;
  if (titleKey === baseTitleKey) return true;

  const titleWords = titleKey.split(' ').filter((word) => word.length > 2);
  const baseWords = baseTitleKey.split(' ').filter((word) => word.length > 2);
  if (!titleWords.length || !baseWords.length) return false;

  const sharedWords = titleWords.filter((word) => baseWords.includes(word));
  const similarity = sharedWords.length / Math.max(titleWords.length, baseWords.length);

  return similarity >= 0.8;
}

function splitArtistAndTrack(title) {
  const cleanedTitle = (title || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const match = cleanedTitle.match(/^(.+?)\s+-\s+(.+)$/);
  if (!match) return null;

  return {
    artist: match[1].trim(),
    track: match[2].trim()
  };
}

function getArtistKeyFromTitle(title) {
  const parts = splitArtistAndTrack(title);
  return parts?.artist ? normalizeSongTitle(parts.artist) : null;
}

function titleContainsTrack(titleKey, trackTitle = '') {
  const trackKey = normalizeSongTitle(trackTitle);
  if (!titleKey || !trackKey) return false;

  const titleWords = titleKey.split(' ');
  const trackWords = trackKey.split(' ').filter((word) => word.length > 1);

  return trackWords.length > 0 && trackWords.every((word) => titleWords.includes(word));
}

function extractYouTubeVideoId(url) {
  if (!url || typeof url !== 'string') return null;

  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /music\.youtube\.com\/watch\?[^#]*v=([a-zA-Z0-9_-]{11})/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(url.trim())) {
    return url.trim();
  }

  return null;
}

function getSongVideoId(song) {
  return song?.videoId || extractYouTubeVideoId(song?.url);
}

function getSongTransportKey(song, selector = DEFAULT_YTDLP_FORMAT_SELECTOR) {
  const videoId = getSongVideoId(song);
  const identity = videoId ? `video:${videoId}` : `url:${song?.url || ''}`;
  return `${selector}|${identity}`;
}

function getTransportPreloadSongLabel(song) {
  const title = sanitizeDiagnosticText(song?.title || 'sin titulo').split('\n')[0].slice(0, 120);
  return `title=${title}, videoId=${getSongVideoId(song) || 'n/a'}, source=${song?.source || 'unknown'}`;
}

function getVerifiedRadioSongLabel(entryOrSong) {
  const song = entryOrSong?.song || entryOrSong;
  const title = sanitizeDiagnosticText(song?.title || 'sin titulo').split('\n')[0].slice(0, 120);
  return `title=${title}, videoId=${getSongVideoId(song) || 'n/a'}`;
}

function getVerifiedRadioQueueStats() {
  return {
    ready: verifiedRadioQueue.length,
    target: VERIFIED_RADIO_QUEUE_MAX
  };
}

function hasVerifiedRadioQueueCapacity() {
  return verifiedRadioQueue.length < VERIFIED_RADIO_QUEUE_MAX;
}

function clearVerifiedRadioQueue(reason) {
  const count = verifiedRadioQueue.length;
  verifiedRadioQueue.length = 0;

  if (count) {
    console.log(`[verified-radio] Limpiando cola verificada: reason=${reason}, entries=${count}`);
  }
}

function pushVerifiedRadioEntry(song, ytDlpResult) {
  if (!song || !ytDlpResult) return false;
  if (!hasVerifiedRadioQueueCapacity()) return false;

  verifiedRadioQueue.push({
    song,
    ytDlpResult,
    verifiedAt: Date.now()
  });

  const stats = getVerifiedRadioQueueStats();
  console.log(
    `[verified-radio] Agregada a cola verificada ${stats.ready}/${stats.target}: ` +
    `${getVerifiedRadioSongLabel(song)}, ` +
    `format_id=${ytDlpResult.transportFormat?.formatId || ytDlpResult.format_id || 'n/a'}, ` +
    `ext=${ytDlpResult.transportFormat?.ext || ytDlpResult.ext || 'n/a'}`
  );

  return true;
}

function shiftVerifiedRadioEntry() {
  const entry = verifiedRadioQueue.shift();
  if (!entry) return null;

  const stats = getVerifiedRadioQueueStats();
  console.log(
    `[verified-radio] Usando entrada verificada. remaining=${stats.ready}/${stats.target}: ` +
    `${getVerifiedRadioSongLabel(entry)}`
  );

  return entry;
}

function getNavigationSongLabel(song) {
  return song?.title || getSongVideoId(song) || 'sin titulo';
}

function syncPendingPostPreviousNextSong() {
  pendingPostPreviousNextSong = forwardStack[0] || null;
}

function clearForwardStack(reason) {
  const count = forwardStack.length;
  forwardStack.length = 0;
  syncPendingPostPreviousNextSong();

  if (count) {
    console.log(`[navigation] Limpiando forwardStack: reason=${reason}, entries=${count}`);
  }
}

function pushHistorySong(song, reason = 'history') {
  if (!song) return;

  history.push(song);
  while (history.length > NAV_HISTORY_MAX) {
    const removed = history.shift();
    console.log(
      `[navigation] Descartando history por limite: reason=${reason}, ` +
      `${getNavigationSongLabel(removed)}, remaining=${history.length}/${NAV_HISTORY_MAX}`
    );
  }
}

function pushForwardSong(song, reason = 'previous') {
  if (!song) return;

  forwardStack.unshift(song);
  while (forwardStack.length > NAV_FORWARD_MAX) {
    const removed = forwardStack.pop();
    console.log(
      `[navigation] Descartando forward por limite: reason=${reason}, ` +
      `${getNavigationSongLabel(removed)}, remaining=${forwardStack.length}/${NAV_FORWARD_MAX}`
    );
  }

  syncPendingPostPreviousNextSong();
  console.log(
    `[navigation] Guardando forward: reason=${reason}, ` +
    `${getNavigationSongLabel(song)}, forward=${forwardStack.length}/${NAV_FORWARD_MAX}`
  );
}

function shiftForwardSong(reason = 'skip') {
  const song = forwardStack.shift() || pendingPostPreviousNextSong;
  syncPendingPostPreviousNextSong();

  if (song) {
    console.log(
      `[navigation] Usando forward: reason=${reason}, ` +
      `${getNavigationSongLabel(song)}, remaining=${forwardStack.length}/${NAV_FORWARD_MAX}`
    );
  }

  return song || null;
}

function hasForwardSongs() {
  return forwardStack.length > 0 || Boolean(pendingPostPreviousNextSong);
}

function getTransportAgeMs(resolvedAt, now = Date.now()) {
  return now - resolvedAt;
}

function isTransportFresh(ageMs) {
  return Number.isFinite(ageMs) && ageMs <= TRANSPORT_SOFT_REFRESH_MS;
}

function isTransportRefreshDue(ageMs, hardTtlMs) {
  return Number.isFinite(ageMs) &&
    ageMs > TRANSPORT_SOFT_REFRESH_MS &&
    ageMs <= hardTtlMs;
}

function isTransportHardExpired(ageMs, hardTtlMs) {
  return !Number.isFinite(ageMs) || ageMs > hardTtlMs;
}

function getUpcomingSongsForTransportBuffer(limit = TRANSPORT_PRELOAD_BUFFER_MAX) {
  const songs = [];
  const seenKeys = new Set();
  // Forward navigation is served by recentTransportCache.
  // Keep this legacy transport buffer focused on manual/radio so forwardStack
  // does not evict prepared radio transports.
  const candidates = [
    ...manualQueue,
    ...(radioMode ? radioQueue : [])
  ];

  for (const song of candidates) {
    if (!isYouTubeSong(song)) continue;
    const key = getSongTransportKey(song, DEFAULT_YTDLP_FORMAT_SELECTOR);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    songs.push(song);
    if (songs.length >= limit) break;
  }

  return songs;
}

function getTransportPreloadStats() {
  let ready = 0;
  let pending = 0;
  for (const entry of transportPreloadBuffer.entriesByKey.values()) {
    if (entry.status === 'ready') ready += 1;
    if (entry.status === 'pending') pending += 1;
  }
  return { ready, pending };
}

function pruneExpiredTransportPreloads() {
  const now = Date.now();
  let expired = 0;
  for (const [key, entry] of transportPreloadBuffer.entriesByKey) {
    if (entry.status !== 'ready') continue;
    const ageMs = getTransportAgeMs(entry.resolvedAt, now);
    if (ageMs <= TRANSPORT_PRELOAD_TTL_MS) continue;
    entry.cancelled = true;
    entry.status = 'cancelled';
    transportPreloadBuffer.entriesByKey.delete(key);
    expired += 1;
    console.log(
      `[transport-buffer] Descartado: reason=expirado, source=preload, ` +
      `ageMs=${ageMs}, fresh=${isTransportFresh(ageMs)}, ` +
      `refreshDue=${isTransportRefreshDue(ageMs, TRANSPORT_PRELOAD_TTL_MS)}, ` +
      `hardExpired=${isTransportHardExpired(ageMs, TRANSPORT_PRELOAD_TTL_MS)}, ` +
      `${getTransportPreloadSongLabel(entry.song)}`
    );
  }
  transportPreloadBuffer.order = transportPreloadBuffer.order.filter(
    (key) => transportPreloadBuffer.entriesByKey.has(key)
  );
  return expired;
}

function cancelTransportPreload(reason) {
  const count = transportPreloadBuffer.entriesByKey.size;
  transportPreloadBuffer.generation += 1;
  for (const entry of transportPreloadBuffer.entriesByKey.values()) {
    entry.cancelled = true;
    entry.status = 'cancelled';
  }
  transportPreloadBuffer.entriesByKey.clear();
  transportPreloadBuffer.order = [];
  transportPreloadBuffer.activeKey = null;
  if (count) console.log(`[transport-buffer] Descartado: reason=${reason}, entries=${count}`);
}

async function getPreloadTransportResult(entry) {
  try {
    return await getYtDlpUrl(entry.url, entry.selector);
  } catch (error) {
    if (
      entry.song?.source !== 'manual' ||
      entry.selector !== DEFAULT_YTDLP_FORMAT_SELECTOR ||
      !isMusicPremiumRestriction(error)
    ) {
      throw error;
    }

    const generation = foregroundTransportResolutionGeneration;
    const alternative = await findMusicPremiumAlternative(
      entry.song, generation, null, error.premiumMetadata, entry
    );

    if (!alternative) throw error;

    return {
      ...alternative.result,
      title: alternative.title,
      premiumAlternativeVideoUrl: alternative.url
    };
  }
}

function startSingleTransportPreload(entry, reason) {
  if (transportPreloadBuffer.activePromise) return transportPreloadBuffer.activePromise;

  const generation = transportPreloadBuffer.generation;
  const position = transportPreloadBuffer.order.indexOf(entry.key) + 1;
  entry.status = 'pending';
  entry.startedAt = Date.now();
  transportPreloadBuffer.activeKey = entry.key;
  console.log(
    `[transport-buffer] Iniciando preload ${position}/${TRANSPORT_PRELOAD_BUFFER_MAX}: ` +
    `${getTransportPreloadSongLabel(entry.song)}, selector=${entry.selector}, reason=${reason}`
  );

  const promise = getPreloadTransportResult(entry)
    .then((result) => {
      const isCurrent = generation === transportPreloadBuffer.generation &&
        !entry.cancelled && transportPreloadBuffer.entriesByKey.get(entry.key) === entry;
      if (!isCurrent) return null;
      entry.status = 'ready';
      entry.result = result;
      entry.resolvedAt = Date.now();
      console.log(
        `[transport-buffer] Preload listo en ${entry.resolvedAt - entry.startedAt} ms: ` +
        `${getTransportPreloadSongLabel(entry.song)}, format_id=${result.transportFormat?.formatId || 'n/a'}, ` +
        `ext=${result.transportFormat?.ext || 'n/a'}`
      );
      return result;
    })
    .catch((error) => {
      entry.cancelled = true;
      entry.status = 'failed';
      entry.error = error;
      if (transportPreloadBuffer.entriesByKey.get(entry.key) === entry) {
        transportPreloadBuffer.entriesByKey.delete(entry.key);
        transportPreloadBuffer.order = transportPreloadBuffer.order.filter((key) => key !== entry.key);
      }
      console.warn(`[transport-buffer] Preload fallo: ${sanitizeDiagnosticText(error)}`);
      return null;
    })
    .finally(() => {
      if (transportPreloadBuffer.activePromise === promise) {
        transportPreloadBuffer.activePromise = null;
        transportPreloadBuffer.activeKey = null;
        fillTransportPreloadBuffer('preload-finished');
      }
    });

  entry.promise = promise;
  transportPreloadBuffer.activePromise = promise;
  return promise;
}

function fillTransportPreloadBuffer(reason = 'fill') {
  if (foregroundTransportResolutionInProgress) {
    console.log('[transport-buffer] Pausado: foreground transport resolution in progress');
    return null;
  }
  if (transportPreloadBuffer.activePromise) return transportPreloadBuffer.activePromise;
  const key = transportPreloadBuffer.order.find((entryKey) => {
    return transportPreloadBuffer.entriesByKey.get(entryKey)?.status === 'queued';
  });
  if (!key) return null;
  return startSingleTransportPreload(transportPreloadBuffer.entriesByKey.get(key), reason);
}

function reconcileTransportPreloadBuffer(reason = 'reconcile') {
  const expired = pruneExpiredTransportPreloads();
  const songs = getUpcomingSongsForTransportBuffer();
  const targetKeys = songs.map((song) => getSongTransportKey(song, DEFAULT_YTDLP_FORMAT_SELECTOR));
  const targetSet = new Set(targetKeys);

  for (const [key, entry] of transportPreloadBuffer.entriesByKey) {
    if (targetSet.has(key)) continue;
    entry.cancelled = true;
    entry.status = 'cancelled';
    transportPreloadBuffer.entriesByKey.delete(key);
    console.log(`[transport-buffer] Descartado: reason=${reason}, ${getTransportPreloadSongLabel(entry.song)}`);
  }

  for (const song of songs) {
    const key = getSongTransportKey(song, DEFAULT_YTDLP_FORMAT_SELECTOR);
    if (transportPreloadBuffer.entriesByKey.has(key)) continue;
    transportPreloadBuffer.entriesByKey.set(key, {
      key,
      song,
      url: song.url,
      videoId: getSongVideoId(song),
      selector: DEFAULT_YTDLP_FORMAT_SELECTOR,
      status: 'queued',
      startedAt: null,
      resolvedAt: null,
      promise: null,
      result: null,
      error: null,
      cancelled: false
    });
  }

  transportPreloadBuffer.order = targetKeys.filter((key) => transportPreloadBuffer.entriesByKey.has(key));
  const stats = getTransportPreloadStats();
  console.log(
    `[transport-buffer] Reconciliando buffer: reason=${reason}, ` +
    `target=${TRANSPORT_PRELOAD_BUFFER_MAX}, known=${songs.length}`
  );
  console.log(
    `[transport-buffer] Buffer stats: ready=${stats.ready}, pending=${stats.pending}, expired=${expired}`
  );
  fillTransportPreloadBuffer(reason);
}

async function consumeTransportPreload(song, selector) {
  const key = getSongTransportKey(song, selector);
  const entry = transportPreloadBuffer.entriesByKey.get(key);
  if (!entry || entry.cancelled) return null;

  if (entry.status === 'queued') {
    entry.cancelled = true;
    transportPreloadBuffer.entriesByKey.delete(key);
    transportPreloadBuffer.order = transportPreloadBuffer.order.filter((entryKey) => entryKey !== key);
    console.log(`[transport-buffer] Descartado: reason=foreground alcanzo entry no iniciada`);
    return null;
  }
  if (entry.status === 'pending') {
    await entry.promise;
  }
  if (entry.status !== 'ready' || !entry.result || entry.cancelled) return null;

  const ageMs = getTransportAgeMs(entry.resolvedAt);
  if (ageMs > TRANSPORT_PRELOAD_TTL_MS) {
    entry.cancelled = true;
    transportPreloadBuffer.entriesByKey.delete(key);
    transportPreloadBuffer.order = transportPreloadBuffer.order.filter((entryKey) => entryKey !== key);
    console.log(
      `[transport-buffer] Descartado: reason=expirado al consumir, source=preload, ` +
      `ageMs=${ageMs}, fresh=${isTransportFresh(ageMs)}, ` +
      `refreshDue=${isTransportRefreshDue(ageMs, TRANSPORT_PRELOAD_TTL_MS)}, ` +
      `hardExpired=${isTransportHardExpired(ageMs, TRANSPORT_PRELOAD_TTL_MS)}`
    );
    return null;
  }

  transportPreloadBuffer.entriesByKey.delete(key);
  transportPreloadBuffer.order = transportPreloadBuffer.order.filter((entryKey) => entryKey !== key);
  const stats = getTransportPreloadStats();
  console.log(
    `[transport-buffer] Usando preload: ${getTransportPreloadSongLabel(song)}, ` +
    `source=preload, ageMs=${ageMs}, fresh=${isTransportFresh(ageMs)}, ` +
    `refreshDue=${isTransportRefreshDue(ageMs, TRANSPORT_PRELOAD_TTL_MS)}, ` +
    `hardExpired=${isTransportHardExpired(ageMs, TRANSPORT_PRELOAD_TTL_MS)}, ` +
    `remaining=${stats.ready}`
  );
  reconcileTransportPreloadBuffer('preload-consumed');
  return entry.result;
}

function pruneRecentTransportCache() {
  const now = Date.now();
  for (const [key, entry] of recentTransportCache) {
    const ageMs = getTransportAgeMs(entry.resolvedAt, now);
    if (ageMs <= RECENT_TRANSPORT_CACHE_TTL_MS) continue;
    recentTransportCache.delete(key);
    console.log(
      `[transport-cache] Descartado por TTL: source=cache, ` +
      `ageMs=${ageMs}, fresh=${isTransportFresh(ageMs)}, ` +
      `refreshDue=${isTransportRefreshDue(ageMs, RECENT_TRANSPORT_CACHE_TTL_MS)}, ` +
      `hardExpired=${isTransportHardExpired(ageMs, RECENT_TRANSPORT_CACHE_TTL_MS)}, ` +
      `${getTransportPreloadSongLabel(entry.song)}`
    );
  }
}

function clearRecentTransportCache(reason) {
  const count = recentTransportCache.size;
  recentTransportCache.clear();
  if (count) {
    console.log(`[transport-cache] Limpiando cache reciente: reason=${reason}, entries=${count}`);
  }
}

function storeRecentTransport(song, selector, result) {
  if (selector !== DEFAULT_YTDLP_FORMAT_SELECTOR || !result) return;

  pruneRecentTransportCache();
  const key = getSongTransportKey(song, selector);
  recentTransportCache.delete(key);
  recentTransportCache.set(key, {
    key,
    song,
    url: song.url,
    videoId: getSongVideoId(song),
    selector,
    resolvedAt: Date.now(),
    result
  });

  while (recentTransportCache.size > RECENT_TRANSPORT_CACHE_MAX) {
    recentTransportCache.delete(recentTransportCache.keys().next().value);
  }

  console.log(`[transport-cache] Guardando transporte reciente: ${getTransportPreloadSongLabel(song)}`);
}

function getRecentTransportReason(transition) {
  if (transition?.type === 'previous') return 'previous';
  if (transition?.postPrevious) return 'post-previous';
  return null;
}

function getRecentTransportForTransition(song, selector, reason = 'transition') {
  pruneRecentTransportCache();
  const key = getSongTransportKey(song, selector);
  const entry = recentTransportCache.get(key);
  if (!entry) {
    console.log(`[transport-cache] Cache miss para ${reason}: no hay entrada coincidente`);
    return null;
  }

  const ageMs = getTransportAgeMs(entry.resolvedAt);
  recentTransportCache.delete(key);
  recentTransportCache.set(key, entry);
  console.log(
    `[transport-cache] Usando transporte reciente para ${reason}: ` +
    `${getTransportPreloadSongLabel(song)}, source=cache, ageMs=${ageMs}, ` +
    `fresh=${isTransportFresh(ageMs)}, ` +
    `refreshDue=${isTransportRefreshDue(ageMs, RECENT_TRANSPORT_CACHE_TTL_MS)}, ` +
    `hardExpired=${isTransportHardExpired(ageMs, RECENT_TRANSPORT_CACHE_TTL_MS)}`
  );
  return entry.result;
}

function clearTransportRefreshTimer() {
  if (!transportRefreshState.timer) return;
  clearTimeout(transportRefreshState.timer);
  transportRefreshState.timer = null;
}

function cancelTransportRefresh(reason = 'foreground') {
  const hadTimer = Boolean(transportRefreshState.timer);
  clearTransportRefreshTimer();

  const controller = transportRefreshState.controller;
  if (!controller || controller.signal.aborted) return hadTimer;

  console.log(
    `[transport-refresh] Cancelando refresh background: reason=${reason}, ` +
    `key=${transportRefreshState.key || 'n/a'}`
  );
  controller.abort();
  return true;
}

function isTransportRefreshBlocked() {
  const radioPreloadBusy = Boolean(
    currentRadioPreload &&
    !currentRadioPreload.cancelled &&
    !currentRadioPreload.committed
  );

  return foregroundTransportResolutionInProgress ||
    Boolean(transportPreloadBuffer.activePromise) ||
    radioPreloadBusy ||
    Boolean(verifiedRadioFillInProgress) ||
    Boolean(transportRefreshState.activePromise);
}

function startTransportRefresh(entry, owner, reason = 'soft-refresh') {
  if (!entry || !entry.key || !entry.url || !entry.selector || !entry.result) return null;
  if (isTransportRefreshBlocked()) return null;

  const hardTtlMs = owner === 'cache'
    ? RECENT_TRANSPORT_CACHE_TTL_MS
    : TRANSPORT_PRELOAD_TTL_MS;
  const ageMs = getTransportAgeMs(entry.resolvedAt);

  if (!isTransportRefreshDue(ageMs, hardTtlMs)) return null;

  const controller = new AbortController();
  const originalResolvedAt = entry.resolvedAt;

  transportRefreshState.controller = controller;
  transportRefreshState.key = entry.key;
  transportRefreshState.startedAt = Date.now();

  console.log(
    `[transport-refresh] Iniciando: owner=${owner}, reason=${reason}, ` +
    `ageMs=${ageMs}, ${getTransportPreloadSongLabel(entry.song)}`
  );

  const promise = getYtDlpUrl(
    entry.url,
    entry.selector,
    { signal: controller.signal }
  )
    .then((result) => {
      if (controller.signal.aborted) return null;

      const stillCurrent = owner === 'cache'
        ? recentTransportCache.get(entry.key) === entry
        : transportPreloadBuffer.entriesByKey.get(entry.key) === entry;

      if (!stillCurrent || entry.resolvedAt !== originalResolvedAt) {
        console.log(
          `[transport-refresh] Resultado ignorado: owner=${owner}, reason=entry-changed, ` +
          `${getTransportPreloadSongLabel(entry.song)}`
        );
        return null;
      }

      entry.result = result;
      entry.resolvedAt = Date.now();

      console.log(
        `[transport-refresh] Actualizado en ` +
        `${entry.resolvedAt - transportRefreshState.startedAt} ms: ` +
        `owner=${owner}, ${getTransportPreloadSongLabel(entry.song)}`
      );

      return result;
    })
    .catch((error) => {
      if (controller.signal.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        console.log(
          `[transport-refresh] Abortado: owner=${owner}, ` +
          `${getTransportPreloadSongLabel(entry.song)}`
        );
        return null;
      }

      console.warn(
        `[transport-refresh] Fallo; se conserva transporte anterior: owner=${owner}, ` +
        `${sanitizeDiagnosticText(error)}`
      );
      return null;
    })
    .finally(() => {
      if (transportRefreshState.activePromise === promise) {
        transportRefreshState.activePromise = null;
        transportRefreshState.controller = null;
        transportRefreshState.key = null;
        transportRefreshState.startedAt = null;
      }
    });

  transportRefreshState.activePromise = promise;
  return promise;
}

function getHotTransportRefreshCandidates() {
  const candidates = [];
  const seenKeys = new Set();

  const addCacheSong = (song, lane) => {
    if (!song) return;
    const key = getSongTransportKey(song, DEFAULT_YTDLP_FORMAT_SELECTOR);
    if (seenKeys.has(key)) return;

    const entry = recentTransportCache.get(key);
    if (!entry || !entry.result) return;

    seenKeys.add(key);
    candidates.push({ entry, owner: 'cache', lane });
  };

  const recentHistory = history
    .slice(-HOT_BACK_TRANSPORTS_MAX)
    .reverse();

  for (const song of recentHistory) {
    addCacheSong(song, 'history');
  }

  for (const song of forwardStack.slice(0, HOT_FORWARD_TRANSPORTS_MAX)) {
    addCacheSong(song, 'forward');
  }

  let preparedRadioCount = 0;

  for (const key of transportPreloadBuffer.order) {
    if (preparedRadioCount >= PREPARED_RADIO_TRANSPORTS_MAX) break;

    const entry = transportPreloadBuffer.entriesByKey.get(key);
    if (
      !entry ||
      entry.cancelled ||
      entry.status !== 'ready' ||
      !entry.result ||
      entry.song?.source !== 'radio' ||
      seenKeys.has(key)
    ) {
      continue;
    }

    seenKeys.add(key);
    candidates.push({
      entry,
      owner: 'preload',
      lane: 'radio'
    });
    preparedRadioCount += 1;
  }

  return candidates;
}

function scheduleTransportRefresh(reason = 'schedule', delayMs = 0) {
  if (!transportRefreshState.enabled) return null;

  clearTransportRefreshTimer();

  transportRefreshState.timer = setTimeout(() => {
    transportRefreshState.timer = null;
    runTransportRefreshScheduler(reason);
  }, Math.max(0, delayMs));

  return transportRefreshState.timer;
}

function runTransportRefreshScheduler(reason = 'scheduler') {
  if (!transportRefreshState.enabled) return null;

  const candidates = getHotTransportRefreshCandidates();
  if (!candidates.length) return null;

  if (isTransportRefreshBlocked()) {
    scheduleTransportRefresh(`${reason}-blocked`, 2000);
    return null;
  }

  let nextDelayMs = null;

  for (const candidate of candidates) {
    const { entry, owner, lane } = candidate;
    const hardTtlMs = owner === 'cache'
      ? RECENT_TRANSPORT_CACHE_TTL_MS
      : TRANSPORT_PRELOAD_TTL_MS;
    const ageMs = getTransportAgeMs(entry.resolvedAt);

    if (isTransportHardExpired(ageMs, hardTtlMs)) {
      continue;
    }

    if (isTransportRefreshDue(ageMs, hardTtlMs)) {
      const promise = startTransportRefresh(
        entry,
        owner,
        `scheduler-${lane}`
      );

      if (promise) {
        promise.finally(() => {
          scheduleTransportRefresh('refresh-finished', 500);
        });
        return promise;
      }

      continue;
    }

    if (isTransportFresh(ageMs)) {
      const untilRefreshDue =
        TRANSPORT_SOFT_REFRESH_MS - ageMs + 250;

      if (
        nextDelayMs === null ||
        untilRefreshDue < nextDelayMs
      ) {
        nextDelayMs = untilRefreshDue;
      }
    }
  }

  if (nextDelayMs !== null) {
    scheduleTransportRefresh(
      'next-soft-threshold',
      Math.max(1000, nextDelayMs)
    );
  }

  return null;
}

function createForegroundTransportCancelledError(reason = 'cancelled') {
  const error = new Error(`Foreground transport cancelado: ${reason}`);
  error.code = FOREGROUND_TRANSPORT_CANCELLED_CODE;
  return error;
}

function isForegroundTransportCancelledError(error) {
  return error?.code === FOREGROUND_TRANSPORT_CANCELLED_CODE;
}

function assertForegroundTransportResolutionCurrent(generation) {
  if (generation !== foregroundTransportResolutionGeneration) {
    throw createForegroundTransportCancelledError('stale-resolution');
  }
}

function cancelForegroundTransportResolution(reason = 'cancelled') {
  foregroundTransportResolutionGeneration += 1;
  foregroundTransportResolutionInProgress = false;

  const controller = foregroundTransportController;
  foregroundTransportController = null;

  if (controller && !controller.signal.aborted) {
    console.log(`[transport] Cancelando resolucion foreground: reason=${reason}`);
    controller.abort();
  }
}

async function resolveSongTransport(song, selector, transportRetryCount, transition = null) {
  cancelTransportRefresh(`foreground-${transition?.type || 'playback'}`);
  foregroundTransportResolutionInProgress = true;

  const resolutionGeneration = foregroundTransportResolutionGeneration;

  const canUseLoadingCue =
    transportRetryCount === 0 &&
    selector === DEFAULT_YTDLP_FORMAT_SELECTOR &&
    transition?.type !== 'previous' &&
    transition?.type !== 'skip' &&
    !transition?.postPrevious;

  const connection = canUseLoadingCue && activeGuildId
    ? getVoiceConnection(activeGuildId)
    : null;

  let loadingCueStarted = false;

  try {
    const recentTransportReason = getRecentTransportReason(transition);
    if (
      transportRetryCount === 0 &&
      selector === DEFAULT_YTDLP_FORMAT_SELECTOR &&
      recentTransportReason
    ) {
      const cachedResult = getRecentTransportForTransition(song, selector, recentTransportReason);
      if (cachedResult) return { result: cachedResult, usedPreload: false, usedCache: true };
    }

    if (transportRetryCount === 0 && selector === DEFAULT_YTDLP_FORMAT_SELECTOR) {
      const preloadKey = getSongTransportKey(song, selector);
      const preloadEntry = transportPreloadBuffer.entriesByKey.get(preloadKey);

      const waitingForPendingPreload = Boolean(
        preloadEntry &&
        !preloadEntry.cancelled &&
        preloadEntry.status === 'pending'
      );

      if (canUseLoadingCue && waitingForPendingPreload) {
        loadingCueStarted = startLoadingCue(
          connection,
          'foreground-preload-pending'
        );
      }

      const preloadedResult = await consumeTransportPreload(song, selector);

      assertForegroundTransportResolutionCurrent(resolutionGeneration);

      if (preloadedResult) {
        if (loadingCueStarted) {
          stopLoadingCue('foreground-preload-ready');
          loadingCueStarted = false;
        }

        return {
          result: preloadedResult,
          usedPreload: true,
          usedCache: false
        };
      }
    }

    assertForegroundTransportResolutionCurrent(resolutionGeneration);

    const startedAt = Date.now();

    if (canUseLoadingCue && !loadingCueStarted) {
      loadingCueStarted = startLoadingCue(
        connection,
        'foreground-cache-preload-miss'
      );
    }

    const controller = new AbortController();
    foregroundTransportController = controller;

    let result;

    try {
      result = await getYtDlpUrl(song.url, selector, {
        signal: controller.signal
      });

      assertForegroundTransportResolutionCurrent(resolutionGeneration);
    } catch (error) {
      if (
        controller.signal.aborted ||
        resolutionGeneration !== foregroundTransportResolutionGeneration
      ) {
        throw createForegroundTransportCancelledError('stop/cleanup');
      }

      throw error;
    } finally {
      if (foregroundTransportController === controller) {
        foregroundTransportController = null;
      }

      if (loadingCueStarted) {
        stopLoadingCue('foreground-resolution-finished');
        loadingCueStarted = false;
      }
    }

    console.log(
      `[transport] yt-dlp listo en ${Date.now() - startedAt} ms: selector=${selector}, ` +
      `format_id=${result.transportFormat?.formatId || result.format_id || 'n/a'}, ` +
      `ext=${result.transportFormat?.ext || result.ext || 'n/a'}`
    );

    return { result, usedPreload: false, usedCache: false };
  } catch (error) {
    if (loadingCueStarted) {
      stopLoadingCue('foreground-resolution-error');
    }

    foregroundTransportResolutionInProgress = false;
    throw error;
  }
}

function logTransitionToFfmpegInput(transition, usedPreload, usedCache = false) {
  if (!transition?.type || !transition.startedAt) return;
  const stats = getTransportPreloadStats();

  console.log(
    `[transport-latency] transition=${transition.type}, post-previous=${Boolean(transition.postPrevious)}, ` +
    `radio-preload=${Boolean(transition.radioPreload)}, cache=${usedCache}, preload=${usedPreload}, ` +
    `bufferReady=${stats.ready}, bufferPending=${stats.pending}, ` +
    `toFfmpegInputMs=${Date.now() - transition.startedAt}`
  );
}

function isRadioQueueDuplicate(url, titleKey) {
  return radioQueue.some((song) => {
    return song.url === url || normalizeSongTitle(song.title) === titleKey;
  });
}

function isPlayableSearchResult(result, baseTitle = '', trackTitle = '') {
  const titleKey = normalizeSongTitle(result?.title);
  const baseTitleKey = normalizeSongTitle(baseTitle);
  const artistKey = getArtistKeyFromTitle(result?.title);
  const durationSeconds = getDurationSeconds(result);
  const repeatsRadioArtist = lastRadioArtistKey &&
    radioArtistStreak >= 2 &&
    artistKey === lastRadioArtistKey;

  return result?.url &&
    /^https?:\/\//.test(result.url) &&
    !/list=/.test(result.url) &&
    !playedUrls.has(result.url) &&
    titleKey &&
    !isRadioQueueDuplicate(result.url, titleKey) &&
    !titleKeysAreTooSimilar(titleKey, baseTitleKey) &&
    !titleContainsTrack(titleKey, trackTitle) &&
    !playedTitleKeys.has(titleKey) &&
    !repeatsRadioArtist &&
    !looksLikeLongFormRadioResult(result.title) &&
    (durationSeconds === null || durationSeconds <= 10 * 60);
}

function isPlayableYtMusicRecommendation(recommendation, baseTitle = '', trackTitle = '') {
  const titleKey = normalizeSongTitle(recommendation?.title);
  const baseTitleKey = normalizeSongTitle(baseTitle);
  const artistKey = getArtistKeyFromTitle(recommendation?.title);
  const repeatsRadioArtist = lastRadioArtistKey &&
    radioArtistStreak >= 2 &&
    artistKey === lastRadioArtistKey;

  return recommendation?.videoId &&
    recommendation?.url &&
    /^https?:\/\//.test(recommendation.url) &&
    !/list=/.test(recommendation.url) &&
    titleKey &&
    !playedUrls.has(recommendation.url) &&
    !playedTitleKeys.has(titleKey) &&
    !isRadioQueueDuplicate(recommendation.url, titleKey) &&
    !titleKeysAreTooSimilar(titleKey, baseTitleKey) &&
    !titleContainsTrack(titleKey, trackTitle) &&
    !repeatsRadioArtist;
}

function markSongAsPlayed(song) {
  if (song?.url) {
    playedUrls.add(song.url);
  }

  const titleKey = normalizeSongTitle(song?.title);
  if (titleKey) {
    playedTitleKeys.add(titleKey);
  }
}

function playResourceForSong(song, resource, {
  transportRetryCount = 0,
  transportFormat = null
} = {}) {
  const playback = {
    id: ++playbackSequence,
    song,
    resource,
    startedAt: null,
    playerError: null,
    expectedShutdown: false,
    expectedShutdownReason: null,
    transportRetryCount,
    transportFormat,
    ffmpegState: resource.metadata?.ffmpegState || null
  };

  resource.metadata = {
    ...(resource.metadata || {}),
    playback
  };

  activePlayback = playback;
  player.play(resource);
  return playback;
}

function markActivePlaybackExpectedShutdown(reason) {
  if (!activePlayback) return;

  activePlayback.expectedShutdown = true;
  activePlayback.expectedShutdownReason = reason;

  if (!activePlayback.ffmpegState) return;

  activePlayback.ffmpegState.expectedShutdown = true;
  activePlayback.ffmpegState.expectedShutdownReason = reason;
}

async function notifyPlaybackFailure(song, reason) {
  const channel = await getControlsChannel();
  if (!channel) return null;

  const title = song?.title || song?.url || 'esa cancion';
  const sanitizedReason = sanitizeDiagnosticText(reason);
  const detail = sanitizedReason ? ` (${sanitizedReason.split('\n')[0].slice(0, 180)})` : '';
  return showPanelNotice('Playback failed.', channel);
}

async function handlePlaybackFailure(failedSong, reason = '') {
  if (!failedSong) {
    console.warn('Fallo de playback sin cancion asociada. No avanzo automaticamente.');
    startInactivityTimer(getCleanupGuildId());
    return null;
  }

  if (failedSong.source === 'manual') {
    await notifyPlaybackFailure(failedSong, reason);

    if (manualQueue.length) {
      console.log('La cancion manual fallo. Intentando la siguiente cancion manual en cola.');
      return advanceToNextSong({ allowRadio: false });
    }

    console.log('La cancion manual fallo y no quedan pedidos manuales. Quedo idle.');
    await updateControlsMessage();
    startInactivityTimer(getCleanupGuildId());
    return null;
  }

  if (failedSong.source === 'radio') {
    consecutiveRadioFailures += 1;
    markSongAsPlayed(failedSong);
    console.warn(`[radio] Fallo consecutivo ${consecutiveRadioFailures}/${MAX_CONSECUTIVE_RADIO_FAILURES}.`);

    if (consecutiveRadioFailures >= MAX_CONSECUTIVE_RADIO_FAILURES) {
      radioMode = false;
      radioQueue.length = 0;
      await notifyPlaybackFailure(failedSong, 'La radio se detuvo por varios fallos consecutivos');
      await updateControlsMessage();
      startInactivityTimer(getCleanupGuildId());
      return null;
    }

    return advanceToNextSong({ allowManual: false, allowRadio: true });
  }

  await notifyPlaybackFailure(failedSong, reason);
  startInactivityTimer(getCleanupGuildId());
  return null;
}

function isYouTubeSong(song) {
  return Boolean(song?.url && /(?:youtube\.com|youtu\.be)/i.test(song.url));
}

function isTransientYouTubeTransportFailure(reason) {
  return /(?:HTTP (?:error )?403|403 Forbidden|access denied|unable to download video data|Invalid data found when processing input|Temporary failure in name resolution|Name or service not known|Connection timed out|Connection reset|Network is unreachable|Input\/output error|\bTLS\b)/i.test(reason || '');
}

function isEarly403Failure(reason) {
  return /(?:HTTP (?:error )?403|403 Forbidden|access denied)/i.test(reason || '');
}

function isWebm251TransportFormat(transportFormat) {
  return transportFormat?.formatId === '251' ||
    transportFormat?.ext === 'webm' ||
    transportFormat?.acodec === 'opus';
}

function canRetryYouTubeTransport(song, reason, playedMs, transportRetryCount) {
  return isYouTubeSong(song) &&
    playedMs < YOUTUBE_TRANSPORT_RETRY_EARLY_MS &&
    transportRetryCount < MAX_YOUTUBE_TRANSPORT_RETRIES &&
    isTransientYouTubeTransportFailure(reason);
}

async function retryYouTubeTransportPlayback(song, transportRetryCount, reason, transportFormat) {
  const nextRetryCount = transportRetryCount + 1;
  const title = song?.title || song?.url || 'cancion sin titulo';
  const useM4aRetry = isEarly403Failure(reason) && isWebm251TransportFormat(transportFormat);
  const formatSelector = useM4aRetry
    ? M4A_RETRY_FORMAT_SELECTOR
    : DEFAULT_YTDLP_FORMAT_SELECTOR;

  console.warn(
    `[transport-retry] Fallo temprano de YouTube. source=${song?.source || 'unknown'}, ` +
    `attempt=${nextRetryCount}/${MAX_YOUTUBE_TRANSPORT_RETRIES}, ` +
    `videoId=${getSongVideoId(song) || 'n/a'}, ` +
    `reason=${sanitizeDiagnosticText(reason).split('\n')[0].slice(0, 180)}`
  );

  if (useM4aRetry) {
    console.warn(
      `[transport-retry] Fallo temprano 403 con format_id=${transportFormat?.formatId || 'n/a'}, ` +
      `ext=${transportFormat?.ext || 'n/a'}.`
    );
    console.log('[transport-retry] Reintentando misma cancion con selector alternativo m4a.');
  }

  console.log(
    `[transport-retry] selector=${formatSelector}, ` +
    `attempt=${nextRetryCount}/${MAX_YOUTUBE_TRANSPORT_RETRIES}.`
  );
  console.log(`[transport-retry] Reextrayendo URL de la misma cancion: ${title}`);

  currentSong = null;
  activePlayback = null;

  try {
    return await playSong(song, {
      transportRetryCount: nextRetryCount,
      ytDlpFormatSelector: formatSelector,
      requireM4aRetry: useM4aRetry
    });
  } catch (retryError) {
    const sanitizedRetryError = sanitizeDiagnosticText(retryError);

    if (useM4aRetry && /Requested format is not available|formato m4a/i.test(sanitizedRetryError)) {
      console.warn('[transport-retry] No hay formato m4a utilizable. Entregando fallo a politica de Etapa 2.');
    }

    console.error(`[transport-retry] Retry fallo antes de iniciar playback: ${sanitizedRetryError}`);
    currentSong = null;
    activePlayback = null;
    return handlePlaybackFailure(song, sanitizedRetryError);
  }
}

async function handlePlaybackAttemptFailure(
  song,
  reason,
  playedMs = 0,
  transportRetryCount = 0,
  transportFormat = null
) {
  foregroundTransportResolutionInProgress = false;

  if (canRetryYouTubeTransport(song, reason, playedMs, transportRetryCount)) {
    return retryYouTubeTransportPlayback(song, transportRetryCount, reason, transportFormat);
  }

  if (isYouTubeSong(song) && transportRetryCount >= MAX_YOUTUBE_TRANSPORT_RETRIES) {
    console.warn(
      `[transport-retry] Retry agotado. source=${song?.source || 'unknown'}, ` +
      `videoId=${getSongVideoId(song) || 'n/a'}. Entregando fallo a politica de Etapa 2.`
    );
  }

  return handlePlaybackFailure(song, reason);
}

async function flushPendingIdleAdvance() {
  if (!pendingIdleAdvance || isAdvancing || isStarting) return null;

  const pendingAdvance = pendingIdleAdvance;
  pendingIdleAdvance = null;
  console.log(`Ejecutando avance diferido: ${sanitizeDiagnosticText(pendingAdvance.reason)}`);

  if (pendingAdvance.kind === 'playback-attempt-failed') {
    return handlePlaybackAttemptFailure(
      pendingAdvance.song,
      pendingAdvance.reason,
      pendingAdvance.playedMs,
      pendingAdvance.transportRetryCount,
      pendingAdvance.transportFormat
    );
  }

  return playNextSong({
    pushCurrentToHistory: pendingAdvance.pushCurrentToHistory
  });
}

function getRadioBaseSong() {
  return radioSeedSong || currentSong || history[history.length - 1] || lastManualSong || null;
}

async function getYtMusicRadioRecommendations(videoId) {
  return new Promise((resolve, reject) => {
    execFile(YTMUSIC_PYTHON_PATH, [YTMUSIC_RADIO_SCRIPT, videoId], {
      cwd: __dirname,
      timeout: YTMUSIC_RADIO_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (stderr && stderr.trim()) {
        console.error('ytmusic_radio.py stderr:', stderr.trim());
      }

      if (error) {
        return reject(error);
      }

      let payload;

      try {
        payload = JSON.parse(stdout);
      } catch (parseError) {
        return reject(new Error(`JSON invalido de ytmusic_radio.py: ${parseError.message}`));
      }

      if (!payload?.ok) {
        return reject(new Error(payload?.error || 'ytmusic_radio.py devolvio ok:false'));
      }

      if (!Array.isArray(payload.recommendations)) {
        return reject(new Error('ytmusic_radio.py no devolvio una lista de recomendaciones'));
      }

      return resolve(payload.recommendations);
    });
  });
}

function buildRadioSongFromRecommendation(recommendation) {
  return {
    url: recommendation.url,
    title: recommendation.title || null,
    videoId: recommendation.videoId,
    source: 'radio'
  };
}

const UNDESIRED_RADIO_TITLE_PATTERNS = [
  { reason: 'live', pattern: /\blive\b/i },
  { reason: 'concert', pattern: /\bconcert\b/i },
  { reason: 'remaster', pattern: /\bremaster\b/i },
  { reason: 'remastered', pattern: /\bremastered\b/i },
  { reason: 'lyrics', pattern: /\blyrics\b/i },
  { reason: 'lyric video', pattern: /\blyric\s+video\b/i },
  { reason: 'karaoke', pattern: /\bkaraoke\b/i },
  { reason: 'cover', pattern: /\bcover\b/i },
  { reason: 'tribute', pattern: /\btribute\b/i },
  { reason: 'slowed', pattern: /\bslowed\b/i },
  { reason: 'reverb', pattern: /\breverb\b/i },
  { reason: 'nightcore', pattern: /\bnightcore\b/i },
  { reason: 'instrumental', pattern: /\binstrumental\b/i },
  { reason: 'demo', pattern: /\bdemo\b/i },
  { reason: 'rehearsal', pattern: /\brehearsal\b/i },
  { reason: 'acoustic version', pattern: /\bacoustic\s+version\b/i },
  { reason: 'full album', pattern: /\bfull\s+album\b/i },
  { reason: 'interview', pattern: /\binterview\b/i }
];

function getUndesiredRadioTitleReason(title) {
  const match = UNDESIRED_RADIO_TITLE_PATTERNS.find(({ pattern }) => pattern.test(title || ''));
  return match?.reason || null;
}

function isUndesiredRadioTitle(title) {
  return Boolean(getUndesiredRadioTitleReason(title));
}

function filterYtMusicRadioSongs(songs) {
  const accepted = [];
  const rejected = [];

  for (const song of songs) {
    const reason = getUndesiredRadioTitleReason(song.title);
    if (reason) {
      rejected.push({ song, reason });
    } else {
      accepted.push(song);
    }
  }

  const minimumForContinuity = Math.min(2, songs.length);
  while (accepted.length < minimumForContinuity && rejected.length) {
    accepted.push(rejected.shift().song);
  }

  for (const { song, reason } of rejected) {
    const title = sanitizeDiagnosticText(song.title || 'sin titulo').split('\n')[0].slice(0, 160);
    console.log(`[radio-filter] Descartado: title=${title}, reason=${reason}`);
  }

  console.log(
    `[radio-filter] Recomendaciones: total=${songs.length}, ` +
    `accepted=${accepted.length}, rejected=${rejected.length}`
  );
  return accepted;
}

function getUniquePlayableYtMusicSongs(recommendations, baseTitle, trackTitle) {
  const seenUrls = new Set();
  const seenTitleKeys = new Set();
  const songs = [];

  for (const recommendation of recommendations) {
    const titleKey = normalizeSongTitle(recommendation?.title);

    if (!isPlayableYtMusicRecommendation(recommendation, baseTitle, trackTitle)) continue;
    if (seenUrls.has(recommendation.url) || seenTitleKeys.has(titleKey)) continue;

    seenUrls.add(recommendation.url);
    seenTitleKeys.add(titleKey);
    songs.push(buildRadioSongFromRecommendation(recommendation));
  }

  return songs;
}

async function buildYtMusicRadioBatch(baseSong, baseTitle, trackTitle) {
  const videoId = getSongVideoId(baseSong);
  if (!videoId) return null;

  const recommendations = await getYtMusicRadioRecommendations(videoId);
  const playableSongs = getUniquePlayableYtMusicSongs(recommendations, baseTitle, trackTitle);
  const songs = filterYtMusicRadioSongs(playableSongs);
  if (!songs.length) return null;

  return {
    baseVideoId: videoId,
    nextSong: songs[0],
    songsToQueue: songs.slice(1, 1 + MAX_RADIO_PREFETCH)
  };
}

function cancelRadioPreload(reason) {
  const preload = currentRadioPreload;
  if (!preload) return;

  preload.cancelled = true;
  preload.cancelReason = reason;
  currentRadioPreload = null;
  console.log(`[radio-preload] Descartado: ${reason}`);
}

function isCurrentRadioPreloadBase(preload) {
  const baseSong = getRadioBaseSong();
  return Boolean(
    preload &&
    !preload.cancelled &&
    radioMode &&
    getSongVideoId(baseSong) === preload.baseVideoId
  );
}

function startRadioPreloadForManualSong(song) {
  const baseVideoId = getSongVideoId(song);

  if (pendingPostPreviousNextSong) {
    console.log('[radio-preload] Omitido tras previous: se conserva cola vigente');
    return null;
  }
  if (song?.source !== 'manual' || !radioMode || !baseVideoId || manualQueue.length) return null;
  if (radioQueue.length) return null;

  const existing = currentRadioPreload;
  if (existing?.baseVideoId === baseVideoId && !existing.cancelled) return existing.promise;
  if (existing) cancelRadioPreload('cambio de cancion base');

  const baseTitle = song.title;
  if (!baseTitle) return null;

  const titleParts = splitArtistAndTrack(baseTitle);
  const trackTitle = titleParts?.track || baseTitle;
  const preload = {
    id: ++radioPreloadGeneration,
    baseVideoId,
    startedAt: Date.now(),
    resolvedAt: null,
    promise: null,
    result: null,
    committed: false,
    error: null,
    cancelled: false,
    cancelReason: null
  };

  console.log(`[radio-preload] Consultando ytmusicapi con videoId base: ${baseVideoId}`);
  currentRadioPreload = preload;

  preload.promise = buildYtMusicRadioBatch(song, baseTitle, trackTitle)
    .then((batch) => {
      if (preload.cancelled || currentRadioPreload !== preload) return null;
      if (!isCurrentRadioPreloadBase(preload)) {
        cancelRadioPreload('la cancion base ya no corresponde');
        return null;
      }
      if (manualQueue.length) {
        cancelRadioPreload('hay pedidos manuales pendientes');
        return null;
      }
      if (radioQueue.length) {
        cancelRadioPreload('radioQueue ya fue preparada');
        return null;
      }
      if (!batch) {
        cancelRadioPreload('ytmusicapi no devolvio recomendaciones utiles');
        return null;
      }

      radioQueue.push(batch.nextSong, ...batch.songsToQueue);
      preload.result = batch;
      preload.resolvedAt = Date.now();
      preload.committed = true;
      console.log(
        `[radio-preload] Radio lista en ${preload.resolvedAt - preload.startedAt} ms. ` +
        `Precargadas ${radioQueue.length} canciones.`
      );
      console.log(
        `[radio-preload] Iniciando transport preload para primera radio: ` +
        `${getTransportPreloadSongLabel(radioQueue[0])}`
      );
      reconcileTransportPreloadBuffer('radio-preload-ready');
      scheduleTransportRefresh('radio-preload-ready');
      return batch;
    })
    .catch((error) => {
      preload.error = error;
      preload.cancelled = true;
      if (currentRadioPreload === preload) currentRadioPreload = null;
      console.warn(`[radio-preload] Fallo: ${sanitizeDiagnosticText(error)}`);
      return null;
    });

  return preload.promise;
}

async function waitForRadioPreloadForAdvance() {
  const preload = currentRadioPreload;
  if (!preload || preload.committed || !isCurrentRadioPreloadBase(preload)) return false;

  await preload.promise;
  return radioQueue.length > 0;
}

function cancelRadioQueueRefill(reason) {
  const refill = currentRadioRefill;
  if (!refill) return;

  refill.cancelled = true;
  refill.cancelReason = reason;
  currentRadioRefill = null;

  console.log(`[radio-refill] Descartado: ${reason}`);
}

function startRadioQueueRefillIfNeeded(baseSong, reason = 'queue-low') {
  if (
    !radioMode ||
    manualQueue.length ||
    radioQueue.length > RADIO_QUEUE_REFILL_THRESHOLD
  ) {
    return null;
  }

  const baseVideoId = getSongVideoId(baseSong);
  const baseTitle = baseSong?.title;

  if (!baseVideoId || !baseTitle) return null;

  const existing = currentRadioRefill;
  if (existing && !existing.cancelled) {
    return existing.promise;
  }

  const titleParts = splitArtistAndTrack(baseTitle);
  const trackTitle = titleParts?.track || baseTitle;

  const refill = {
    baseVideoId,
    startedAt: Date.now(),
    resolvedAt: null,
    promise: null,
    cancelled: false,
    cancelReason: null
  };

  currentRadioRefill = refill;

  console.log(
    `[radio-refill] Consultando ytmusicapi: remaining=${radioQueue.length}, ` +
    `baseVideoId=${baseVideoId}, reason=${reason}`
  );

  refill.promise = buildYtMusicRadioBatch(baseSong, baseTitle, trackTitle)
    .then((batch) => {
      if (refill.cancelled || currentRadioRefill !== refill) return null;

      if (!radioMode || manualQueue.length) {
        cancelRadioQueueRefill('contexto de radio cambio durante refill');
        return null;
      }

      if (!batch) {
        console.log('[radio-refill] Sin recomendaciones utiles; se conserva la cola actual');
        return null;
      }

      const additions = [batch.nextSong, ...batch.songsToQueue];
      radioQueue.push(...additions);
      refill.resolvedAt = Date.now();

      console.log(
        `[radio-refill] Listo en ${refill.resolvedAt - refill.startedAt} ms: ` +
        `agregadas=${additions.length}, radioQueue=${radioQueue.length}`
      );

      reconcileTransportPreloadBuffer('radio-refill-ready');
      scheduleTransportRefresh('radio-refill-ready');

      return batch;
    })
    .catch((error) => {
      console.warn(
        `[radio-refill] Fallo: ${sanitizeDiagnosticText(error)}`
      );
      return null;
    })
    .finally(() => {
      if (currentRadioRefill === refill) {
        currentRadioRefill = null;
      }
    });

  return refill.promise;
}

async function generateYtMusicRadioSong(baseSong, baseTitle, trackTitle) {
  const videoId = getSongVideoId(baseSong);

  if (!videoId) {
    console.log('[radio] ytmusicapi sin videoId base. Usando fallback textual.');
    return null;
  }

  try {
    console.log(`[radio] Consultando ytmusicapi con videoId base: ${videoId}`);
    const batch = await buildYtMusicRadioBatch(baseSong, baseTitle, trackTitle);

    if (!batch) {
      console.log('[radio] ytmusicapi no devolvio recomendaciones utiles. Usando fallback textual.');
      return null;
    }

    const { nextSong, songsToQueue } = batch;

    if (songsToQueue.length) {
      radioQueue.push(...songsToQueue);
    }

    console.log(`[radio] ytmusicapi eligio: ${nextSong.title || nextSong.url}`);
    console.log(`[radio] ytmusicapi dejo ${songsToQueue.length} canciones precargadas.`);

    return nextSong;
  } catch (error) {
    console.error('[radio] Error usando ytmusicapi. Usando fallback textual:', error.message);
    return null;
  }
}

async function generateTextSearchRadioSong(baseTitle, trackTitle) {
  const titleParts = splitArtistAndTrack(baseTitle);
  const artist = titleParts?.artist;
  const queries = artist
    ? [
        `${artist} similar artists`,
        `${artist} related artists`,
        `${artist} radio`,
        `${artist} mix`,
        `${artist} similar songs`,
        `${artist} style music`
      ]
    : [
        `${baseTitle} similar artists songs`,
        `${baseTitle} radio`,
        `${baseTitle} related music`
      ];

  console.log('[radio] Iniciando fallback textual.');

  for (const query of queries) {
    try {
      console.log(`[radio] Busqueda textual: ${query}`);
      const results = await play.search(query, { limit: 10 });
      const playableResults = results.filter((item) => isPlayableSearchResult(item, baseTitle, trackTitle));
      const result = playableResults.find((item) => isPreferredRadioResult(item.title)) || playableResults[0];

      if (result) {
        console.log(`[radio] Fallback textual eligio: ${result.title || result.url}`);

        return {
          url: result.url,
          title: result.title || null,
          source: 'radio'
        };
      }
    } catch (error) {
      console.error('[radio] Error buscando cancion de radio:', error.message);
    }
  }

  console.log('[radio] Fallback textual no encontro canciones utiles.');
  return null;
}

async function generateRadioSong() {
  const baseSong = getRadioBaseSong();
  const baseTitle = baseSong?.title;

  if (!baseTitle) return null;

  const titleParts = splitArtistAndTrack(baseTitle);
  const trackTitle = titleParts?.track || baseTitle;

  const ytmusicSong = await generateYtMusicRadioSong(baseSong, baseTitle, trackTitle);
  if (ytmusicSong) return ytmusicSong;

  return generateTextSearchRadioSong(baseTitle, trackTitle);
}

function isMusicPremiumRestriction(error) {
  return /only available to (?:YouTube )?Music Premium members/i
    .test(String(error?.message || error));
}

async function getMusicPremiumMetadata(url) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP_PATH, [
      '--no-playlist',
      '--skip-download',
      '--ignore-no-formats-error',
      '--js-runtimes', YTDLP_JS_RUNTIME,
      '--extractor-args', 'youtube:player_client=visionos;skip=hls,dash',
      '--print', 'title=%(title)s',
      '--print', 'artist=%(artist)s',
      '--print', 'track=%(track)s',
      url
    ], {
      cwd: __dirname,
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }, (error, stdout) => {
      if (error) return reject(error);

      const fields = {};
      for (const line of stdout.split(/\r?\n/)) {
        const separator = line.indexOf('=');
        if (separator > 0) {
          fields[line.slice(0, separator)] = line.slice(separator + 1).trim();
        }
      }

      const titleParts = splitArtistAndTrack(fields.title);
      const artist = (
        fields.artist && fields.artist !== 'NA'
          ? fields.artist.split(/,\s*/)[0]
          : titleParts?.artist || ''
      ).trim();

      const track = (
        fields.track && fields.track !== 'NA'
          ? fields.track
          : titleParts?.track || fields.title || ''
      ).trim();

      resolve(artist && track ? { artist, track } : null);
    });
  });
}

async function findMusicPremiumAlternative(
  song, generation, transition, knownMetadata = null, preload = null
) {
  const assertCurrent = () => {
    assertForegroundTransportResolutionCurrent(generation);
    if (preload?.cancelled) {
      throw createForegroundTransportCancelledError('preload-cancelled');
    }
  };

  assertCurrent();
  const metadata = knownMetadata || await getMusicPremiumMetadata(song.url);
  assertCurrent();
  if (!metadata) return null;

  const words = (value) => normalizeSongTitle(value).split(' ').filter(Boolean);
  const artistWords = words(metadata.artist);
  const trackWords = words(metadata.track);
  if (!artistWords.length || !trackWords.length) return null;

  const results = await play.search(
    `${metadata.artist} ${metadata.track} official`,
    { limit: 10 }
  );
  assertCurrent();

  const candidates = results.filter((result) => {
    if (!result?.url || !/^https?:\/\//.test(result.url)) return false;
    if (result.url === song.url) return false;

    if (/\b(cover|live|concert|karaoke|remix|reaction|nightcore|sped up|slowed|instrumental|tutorial|tribute)\b/i
      .test(result.title || '')) return false;

    const titleWords = new Set(words(result.title));
    const channelWords = new Set(words(result.channel?.name));

    return trackWords.every((word) => titleWords.has(word)) &&
      artistWords.every((word) =>
        titleWords.has(word) || channelWords.has(word)
      );
  });

  const score = (result) =>
    (/official/i.test(result.channel?.name || '') ? 3 : 0) +
    (/\b(official video|official audio|music video)\b/i.test(result.title || '') ? 2 : 0) +
    (/\btopic\b/i.test(result.channel?.name || '') ? 1 : 0);

  candidates.sort((a, b) => score(b) - score(a));

  for (const candidate of candidates.slice(0, 3)) {
    assertCurrent();

    try {
      const transport = preload
        ? {
            result: await getYtDlpUrl(candidate.url, DEFAULT_YTDLP_FORMAT_SELECTOR),
            usedPreload: false,
            usedCache: false
          }
        : await resolveSongTransport({
            url: candidate.url,
            title: candidate.title,
            source: 'manual'
          }, DEFAULT_YTDLP_FORMAT_SELECTOR, 0, transition);

      assertCurrent();

      return {
        url: candidate.url,
        title: candidate.title,
        ...transport
      };
    } catch (error) {
      if (isForegroundTransportCancelledError(error)) throw error;
      console.warn('[premium-fallback] Alternativa no reproducible:',
        sanitizeDiagnosticText(error));
    }
  }

  return null;
}

async function playSong(song, {
  transportRetryCount = 0,
  ytDlpFormatSelector = DEFAULT_YTDLP_FORMAT_SELECTOR,
  requireM4aRetry = false,
  verifiedYtDlpResult = null,
  transition = null
} = {}) {
  clearInactivityTimer();

  const isPreviousPlayback = transition?.type === 'previous';

  if (isPreviousPlayback && transportRetryCount === 0) {
    console.log('[previous] Conservando continuidad de cola despues de previous');
  } else if (transportRetryCount === 0 && song.source === 'manual') {
    lastManualSong = song;
    radioSeedSong = song;
    radioQueue.length = 0;
    radioCount = 0;
    lastRadioArtistKey = null;
    radioArtistStreak = 0;
  } else if (transportRetryCount === 0 && song.source === 'radio') {
    radioSeedSong = song;
    const artistKey = getArtistKeyFromTitle(song.title);

    if (artistKey && artistKey === lastRadioArtistKey) {
      radioArtistStreak += 1;
    } else {
      lastRadioArtistKey = artistKey;
      radioArtistStreak = artistKey ? 1 : 0;
    }
  }

  let stream;
  let title = song.title || '';
  const isDirectYouTubeUrl = /youtube\.com|youtu\.be/.test(song.url);

  if (isDirectYouTubeUrl) {
    try {
      const transport = verifiedYtDlpResult
        ? {
            result: verifiedYtDlpResult,
            usedPreload: false,
            usedCache: false,
            usedVerifiedRadio: true
          }
        : await resolveSongTransport(
            song,
            ytDlpFormatSelector,
            transportRetryCount,
            transition
          );

      if (transport.usedVerifiedRadio) {
        console.log(
          `[verified-radio] Usando transporte verificado para playback: ` +
          `${getVerifiedRadioSongLabel(song)}`
        );
      }

      const ytDlpResult = transport.result;

      if (ytDlpResult.premiumAlternativeVideoUrl) {
        song.url = ytDlpResult.premiumAlternativeVideoUrl;
      }

      console.log('YouTube detectado, usando yt-dlp directo...');
      song.title = title || ytDlpResult.title || 'Audio desde yt-dlp';
      currentSong = song;
      markSongAsPlayed(song);
      if (transportRetryCount === 0 && !transport.usedCache) {
        storeRecentTransport(song, ytDlpFormatSelector, ytDlpResult);
      }
      logTransitionToFfmpegInput(transition, transport.usedPreload, transport.usedCache);
      const resource = createFfmpegResourceFromUrl(ytDlpResult);
      playResourceForSong(song, resource, {
        transportRetryCount,
        transportFormat: ytDlpResult.transportFormat
      });
      await updateControlsMessage();
      return song.title;
    } catch (ytErr) {
      if (isForegroundTransportCancelledError(ytErr)) {
        console.log('[transport] Playback foreground cancelado antes de iniciar audio.');
        return null;
      }

      if (song.source === 'manual' && isMusicPremiumRestriction(ytErr)) {
        const generation = foregroundTransportResolutionGeneration;
        let alternative;

        try {
          alternative = await findMusicPremiumAlternative(
            song, generation, transition, ytErr.premiumMetadata
          );
          assertForegroundTransportResolutionCurrent(generation);
        } catch (error) {
          if (isForegroundTransportCancelledError(error)) return null;
          console.error('[premium-fallback] Busqueda fallida:',
            sanitizeDiagnosticText(error));
          throw ytErr;
        }

        if (!alternative) throw ytErr;

        song.url = alternative.url;
        song.title = alternative.title;
        currentSong = song;
        markSongAsPlayed(song);

        if (transportRetryCount === 0 && !alternative.usedCache) {
          storeRecentTransport(song, ytDlpFormatSelector, alternative.result);
        }

        logTransitionToFfmpegInput(
          transition, alternative.usedPreload, alternative.usedCache
        );

        const resource = createFfmpegResourceFromUrl(alternative.result);
        playResourceForSong(song, resource, {
          transportRetryCount,
          transportFormat: alternative.result.transportFormat
        });

        await updateControlsMessage();
        return song.title;
      }

      console.log('yt-dlp directo fallo, intentando play-dl:', sanitizeDiagnosticText(ytErr));

      if (requireM4aRetry) {
        throw new Error(`No hay formato m4a utilizable: ${sanitizeDiagnosticText(ytErr)}`);
      }
    }
  }

  try {
    const info = await play.video_info(song.url);
    const video = info.video_details;

    title = video.title;
    song.title = title;
    currentSong = song;
    console.log('Reproduciendo directo:', title);

    stream = await play.stream_from_info(info);
  } catch (err) {
    console.log('Fallo el link directo, intentando yt-dlp...');

    try {
      const transport = await resolveSongTransport(
        song,
        ytDlpFormatSelector,
        transportRetryCount,
        transition
      );
      const ytDlpResult = transport.result;
      console.log('URL de yt-dlp obtenida, creando recurso FFmpeg...');
      song.title = title || ytDlpResult.title || 'Audio desde yt-dlp';
      currentSong = song;
      markSongAsPlayed(song);
      if (transportRetryCount === 0 && !transport.usedCache) {
        storeRecentTransport(song, ytDlpFormatSelector, ytDlpResult);
      }
      logTransitionToFfmpegInput(transition, transport.usedPreload, transport.usedCache);
      const resource = createFfmpegResourceFromUrl(ytDlpResult);
      playResourceForSong(song, resource, {
        transportRetryCount,
        transportFormat: ytDlpResult.transportFormat
      });
      console.log('Fallback yt-dlp exitoso');
      await updateControlsMessage();
      return song.title;
    } catch (ytErr) {
      if (isForegroundTransportCancelledError(ytErr)) {
        console.log('[transport] Fallback foreground cancelado antes de iniciar audio.');
        return null;
      }

      console.error('Error en fallback yt-dlp:', sanitizeDiagnosticText(ytErr));
      if (isDirectYouTubeUrl) {
        throw new Error(`No pude reproducir este link de YouTube: ${ytErr.message}`);
      }

      console.log('No es YouTube directo, buscando alternativa...');
      const search = await play.search(song.url.replace('https://www.youtube.com/watch?v=', ''), { limit: 1 });

      if (!search.length) {
        throw new Error('No encontre alternativa');
      }

      title = search[0].title;
      song.title = title;
      song.url = search[0].url;
      currentSong = song;
      markSongAsPlayed(song);
      console.log('Fallback a:', title);

      stream = await play.stream(search[0].url);
    }
  }

  const resource = createAudioResource(stream.stream, {
    inputType: stream.type,
    metadata: {}
  });

  playResourceForSong(song, resource, { transportRetryCount });
  markSongAsPlayed(song);
  await updateControlsMessage();
  return song.title || title;
}

async function advanceToNextSong({
  pushCurrentToHistory = false,
  allowManual = true,
  allowRadio = true,
  ytDlpFormatSelector = DEFAULT_YTDLP_FORMAT_SELECTOR,
  transition = null
} = {}) {
  if (pushCurrentToHistory && currentSong) {
    pushHistorySong(currentSong, 'advance');
  }

  currentSong = null;
  isPaused = false;

  let nextSong = null;
  let nextTransition = transition;

  if (allowManual && manualQueue.length) {
    nextSong = manualQueue.shift();
  } else if (hasForwardSongs()) {
    nextSong = shiftForwardSong('skip');
    nextTransition = {
      ...(transition || {}),
      type: transition?.type || 'post-previous',
      startedAt: transition?.startedAt || Date.now(),
      postPrevious: true
    };
    console.log(
      `[previous] Usando cancion forward como siguiente: ` +
      `${getNavigationSongLabel(nextSong)}`
    );
  } else if (allowRadio && radioMode) {
    if (!radioQueue.length) {
      await waitForRadioPreloadForAdvance();
    }

    if (radioQueue.length) {
      nextSong = radioQueue.shift();
      radioCount += 1;
      console.log(`[radio] Usando cancion precargada. Quedan ${radioQueue.length} en radioQueue.`);

      if (currentRadioPreload?.committed) {
        currentRadioPreload = null;
      }

      startRadioQueueRefillIfNeeded(nextSong, 'radio-queue-consumed');
    } else {
      nextSong = await generateRadioSong();

      if (nextSong) {
        radioCount += 1;
      }
    }
  }

  if (!nextSong) {
    await updateControlsMessage();
    startInactivityTimer(getCleanupGuildId());
    return null;
  }

  try {
    const title = await playSong(nextSong, { ytDlpFormatSelector, transition: nextTransition });

    if (title === null) {
      console.log('[transport] Avance cancelado antes de iniciar playback.');
      return null;
    }

    console.log('Reproduciendo siguiente cancion:', title);
    await repostControlsMessage();
    return title;
  } catch (error) {
    console.error('Error al reproducir la siguiente cancion:', sanitizeDiagnosticText(error));
    currentSong = null;
    activePlayback = null;
    return handlePlaybackAttemptFailure(nextSong, error.message, 0, 0);
  }
}

async function playNextSong({
  pushCurrentToHistory = false,
  ytDlpFormatSelector = DEFAULT_YTDLP_FORMAT_SELECTOR,
  transition = null
} = {}) {
  if (isAdvancing) {
    console.warn('Avance de cancion ya en curso. Ignorando llamada duplicada.');
    return currentSong?.title || null;
  }

  isAdvancing = true;
  updateControlsMessage().catch(console.error);

  try {
    return await advanceToNextSong({
      pushCurrentToHistory,
      ytDlpFormatSelector,
      transition
    });
  } finally {
    isAdvancing = false;
    updateControlsMessage().catch(console.error);
    await flushPendingIdleAdvance();
  }
}

async function skipToNext() {
  if (isAdvancing) {
    console.warn('Next ignorado porque ya hay un avance en curso.');
    return currentSong?.title || null;
  }

  if (!currentSong && !manualQueue.length && !hasForwardSongs() && !radioQueue.length) return null;

  const transition = {
    type: 'skip',
    startedAt: Date.now(),
    radioPreload: Boolean(currentRadioPreload?.committed && radioQueue.length)
  };

  if (currentSong) {
    pushHistorySong(currentSong, 'skip');
  }

  isSkipping = true;
  markActivePlaybackExpectedShutdown('skip');
  player.stop();
  currentSong = null;
  isPaused = false;

  return playNextSong({
    transition
  });
}

async function playPreviousSong() {
  if (isAdvancing) {
    console.warn('Previous ignorado porque ya hay un avance en curso.');
    return currentSong?.title || null;
  }

  if (!history.length) return null;

  cancelRadioPreload('previous');
  // Keep prepared transports across previous navigation.
  // The radio queue is preserved, so its ready transports must be preserved too.
  console.log('[navigation] Conservando transport-buffer durante previous');

  const previousSong = history.pop();

  if (currentSong) {
    pushForwardSong(currentSong, 'previous');
    console.log(
      `[previous] Guardando cancion actual para volver con skip: ` +
      `${getNavigationSongLabel(currentSong)}`
    );
  }

  isGoingPrevious = true;
  markActivePlaybackExpectedShutdown('previous');
  player.stop();
  currentSong = null;
  isPaused = false;

  return playSong(previousSong, {
    transition: { type: 'previous', startedAt: Date.now() }
  });
}

async function getYtDlpUrl(url, formatSelector = DEFAULT_YTDLP_FORMAT_SELECTOR, options = {}) {
  const { signal } = options;

  return new Promise((resolve, reject) => {
    execFile(YTDLP_PATH, [
      '--no-playlist',
      '--ignore-no-formats-error',
      '--js-runtimes', YTDLP_JS_RUNTIME,
      '--extractor-args', 'youtube:player_client=visionos;skip=hls,dash',
      '-f', formatSelector,
      '--dump-single-json',
      url
    ], {
      cwd: __dirname,
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      signal
    }, (error, stdout, stderr) => {
      if (stderr && stderr.trim()) {
        console.error('yt-dlp stderr:', sanitizeDiagnosticText(stderr));
      }

      if (error) return reject(error);

      let info;

      try {
        info = JSON.parse(stdout);
      } catch (parseError) {
        return reject(new Error(`JSON invalido de yt-dlp: ${parseError.message}`));
      }

      if (
        /only available to (?:YouTube )?Music Premium members/i.test(stderr || '') &&
        Array.isArray(info.formats) &&
        info.formats.length === 0
      ) {
        const titleParts = splitArtistAndTrack(info.title);
        const artist = String(info.artist || titleParts?.artist || '')
          .split(/,\s*/)[0].trim();
        const track = String(info.track || titleParts?.track || info.title || '').trim();

        const premiumError = new Error(
          'This video is only available to Music Premium members'
        );

        if (artist && track) {
          premiumError.premiumMetadata = { artist, track };
        }

        return reject(premiumError);
      }

      const formatCandidates = [
        ...(Array.isArray(info.requested_downloads) ? info.requested_downloads : []),
        ...(Array.isArray(info.requested_formats) ? info.requested_formats : []),
        info
      ];
      const selectedFormat = formatCandidates.find((format) => {
        return /^https?:\/\//.test(format?.url || '') && format?.acodec !== 'none';
      }) || formatCandidates.find((format) => /^https?:\/\//.test(format?.url || ''));

      if (!selectedFormat?.url) {
        return reject(new Error('yt-dlp no devolvio una URL reproducible'));
      }

      if (formatSelector === M4A_RETRY_FORMAT_SELECTOR && selectedFormat.ext !== 'm4a') {
        return reject(new Error('No hay formato m4a utilizable para el retry'));
      }

      const httpHeaders = selectedFormat.http_headers || info.http_headers || {};
      const transportFormat = {
        selector: formatSelector,
        formatId: selectedFormat.format_id ? String(selectedFormat.format_id) : null,
        ext: selectedFormat.ext || null,
        protocol: selectedFormat.protocol || null,
        acodec: selectedFormat.acodec || null
      };
      const logPrefix = formatSelector === M4A_RETRY_FORMAT_SELECTOR
        ? '[transport-retry] Formato alternativo seleccionado:'
        : '[transport]';

      console.log(
        `${logPrefix} selector=${formatSelector}, ` +
        `format_id=${transportFormat.formatId || 'n/a'}, ext=${transportFormat.ext || 'n/a'}, ` +
        `protocol=${transportFormat.protocol || 'n/a'}.`
      );
      resolve({
        title: String(info.title || selectedFormat.title || '').trim(),
        url: selectedFormat.url.trim(),
        http_headers: httpHeaders,
        format_id: selectedFormat.format_id || null,
        ext: selectedFormat.ext || null,
        protocol: selectedFormat.protocol || null,
        transportFormat
      });
    });
  });
}

function isExpectedFfmpegShutdownLog(message, ffmpegState) {
  return ffmpegState?.expectedShutdown &&
    /\b(Connection reset by peer|Broken pipe)\b/i.test(message || '');
}

function getHttpHeader(headers, targetName) {
  const entry = Object.entries(headers || {}).find(([name]) => {
    return name.toLowerCase() === targetName.toLowerCase();
  });

  return entry?.[1] == null ? null : String(entry[1]);
}

function buildFfmpegHttpOptions(httpHeaders = {}) {
  const userAgent = getHttpHeader(httpHeaders, 'User-Agent') || 'Mozilla/5.0';
  const allowedHeaderNames = [
    'Referer',
    'Origin',
    'Cookie',
    'Accept',
    'Accept-Language'
  ];
  const headerLines = [];
  const includedHeaderNames = [];

  for (const headerName of allowedHeaderNames) {
    const value = getHttpHeader(httpHeaders, headerName);
    if (!value) continue;

    const safeValue = value.replace(/[\r\n]+/g, ' ').trim();
    if (!safeValue) continue;

    headerLines.push(`${headerName}: ${safeValue}`);
    includedHeaderNames.push(headerName);
  }

  return {
    userAgent: userAgent.replace(/[\r\n]+/g, ' ').trim() || 'Mozilla/5.0',
    headerBlock: headerLines.length ? `${headerLines.join('\r\n')}\r\n` : null,
    includedHeaderNames
  };
}

function verifyRadioTransport(song, ytDlpResult) {
  return new Promise((resolve, reject) => {
    const title = song?.title || getSongVideoId(song) || 'radio sin titulo';
    const { userAgent, headerBlock } = buildFfmpegHttpOptions(ytDlpResult.http_headers);

    const ffmpegArgs = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '10',
      '-rw_timeout', '15000000',
      '-user_agent', userAgent
    ];

    if (headerBlock) {
      ffmpegArgs.push('-headers', headerBlock);
    }

    ffmpegArgs.push(
      '-i', ytDlpResult.url,
      '-analyzeduration', '0',
      '-probesize', '32',
      '-loglevel', 'warning',
      '-t', String(TRANSPORT_VERIFIER_PROBE_SECONDS),
      '-vn',
      '-f', 'null',
      '-'
    );

    console.log(
      `[transport-verifier] Probando radio: ${sanitizeDiagnosticText(title)}, ` +
      `format_id=${ytDlpResult.transportFormat?.formatId || ytDlpResult.format_id || 'n/a'}, ` +
      `ext=${ytDlpResult.transportFormat?.ext || ytDlpResult.ext || 'n/a'}`
    );

    const ffmpegProcess = spawn(FFMPEG_PATH, ffmpegArgs, {
      cwd: __dirname,
      windowsHide: true
    });

    let stderr = '';
    let settled = false;
    const startedAt = Date.now();

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ffmpegProcess.kill('SIGKILL');
      reject(new Error(`FFmpeg probe timeout after ${TRANSPORT_VERIFIER_TIMEOUT_MS} ms`));
    }, TRANSPORT_VERIFIER_TIMEOUT_MS);

    ffmpegProcess.stderr.on('data', (data) => {
      stderr = `${stderr}\n${sanitizeDiagnosticText(data)}`.slice(-4000);
    });

    ffmpegProcess.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    ffmpegProcess.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code === 0) {
        console.log(
          `[transport-verifier] Radio verificada en ${Date.now() - startedAt} ms: ` +
          `${sanitizeDiagnosticText(title)}`
        );
        resolve(true);
        return;
      }

      reject(new Error(`FFmpeg probe fallo: ${stderr.trim() || `exit code ${code}`}`));
    });
  });
}

async function prepareVerifiedRadioEntry(song, reason = 'prepare') {
  if (!song || song.source !== 'radio') {
    console.warn('[verified-radio] Candidata ignorada: no es source=radio');
    return null;
  }

  if (!hasVerifiedRadioQueueCapacity()) {
    const stats = getVerifiedRadioQueueStats();
    console.log(`[verified-radio] Cola completa ${stats.ready}/${stats.target}. No preparo mas.`);
    return null;
  }

  const startedAt = Date.now();
  const label = getVerifiedRadioSongLabel(song);

  console.log(`[verified-radio] Preparando candidata: ${label}, reason=${reason}`);

  try {
    const ytDlpResult = await getYtDlpUrl(song.url, DEFAULT_YTDLP_FORMAT_SELECTOR);

    if (!song.title && ytDlpResult.title) {
      song.title = ytDlpResult.title;
    }

    await verifyRadioTransport(song, ytDlpResult);

    const pushed = pushVerifiedRadioEntry(song, ytDlpResult);

    if (!pushed) {
      console.log(`[verified-radio] Candidata verificada pero no agregada: ${label}`);
      return null;
    }

    console.log(
      `[verified-radio] Candidata lista en ${Date.now() - startedAt} ms: ` +
      `${getVerifiedRadioSongLabel(song)}`
    );

    return {
      song,
      ytDlpResult
    };
  } catch (error) {
    console.warn(
      `[verified-radio] Candidata descartada: ${label}, ` +
      `reason=${sanitizeDiagnosticText(error).split('\n')[0].slice(0, 180)}`
    );
    return null;
  }
}

async function fillVerifiedRadioQueueFromExistingRadioQueue(reason = 'fill') {
  let prepared = 0;
  let discarded = 0;

  while (hasVerifiedRadioQueueCapacity() && radioQueue.length) {
    const song = radioQueue.shift();

    const entry = await prepareVerifiedRadioEntry(song, reason);

    if (entry) {
      prepared += 1;
    } else {
      discarded += 1;
    }
  }

  const stats = getVerifiedRadioQueueStats();
  console.log(
    `[verified-radio] Fill terminado: reason=${reason}, ` +
    `prepared=${prepared}, discarded=${discarded}, ready=${stats.ready}/${stats.target}, ` +
    `radioQueue=${radioQueue.length}`
  );

  return prepared;
}

function canRunVerifiedRadioFillForPlayback(playback) {
  return Boolean(
    playback &&
    activePlayback?.id === playback.id &&
    playback.startedAt &&
    !playback.playerError &&
    !playback.expectedShutdown &&
    !playback.ffmpegState?.closed &&
    !isStarting &&
    !isAdvancing &&
    !isSkipping &&
    !isStopping &&
    !isGoingPrevious &&
    !playingIntro
  );
}

async function fillVerifiedRadioQueueForStablePlayback(playback, reason = 'stable-playback') {
  if (!canRunVerifiedRadioFillForPlayback(playback)) {
    console.log(`[verified-radio] Fill omitido: playback no estable, reason=${reason}`);
    return 0;
  }

  if (verifiedRadioFillInProgress) {
    console.log(`[verified-radio] Fill omitido: worker ya activo, reason=${reason}`);
    return 0;
  }

  if (!hasVerifiedRadioQueueCapacity()) {
    const stats = getVerifiedRadioQueueStats();
    console.log(`[verified-radio] Fill omitido: cola completa ${stats.ready}/${stats.target}`);
    return 0;
  }

  verifiedRadioFillInProgress = true;

  try {
    if (!radioQueue.length) {
      await waitForRadioPreloadForAdvance();
    }

    if (!canRunVerifiedRadioFillForPlayback(playback)) {
      console.log(`[verified-radio] Fill cancelado: playback cambio durante espera, reason=${reason}`);
      return 0;
    }

    return await fillVerifiedRadioQueueFromExistingRadioQueue(reason);
  } finally {
    verifiedRadioFillInProgress = false;
  }
}

function scheduleVerifiedRadioFillAfterStablePlayback(playback, reason = 'playback-stable') {
  if (!playback?.startedAt) return;

  if (verifiedRadioFillTimer) {
    clearTimeout(verifiedRadioFillTimer);
    verifiedRadioFillTimer = null;
  }

  verifiedRadioFillTimer = setTimeout(() => {
    verifiedRadioFillTimer = null;

    fillVerifiedRadioQueueForStablePlayback(playback, reason).catch((error) => {
      console.warn(`[verified-radio] Worker fallo: ${sanitizeDiagnosticText(error)}`);
    });
  }, MIN_VALID_PLAYBACK_MS);

  console.log(`[verified-radio] Fill programado en ${MIN_VALID_PLAYBACK_MS} ms: reason=${reason}`);
}

function cancelVerifiedRadioFill(reason) {
  if (verifiedRadioFillTimer) {
    clearTimeout(verifiedRadioFillTimer);
    verifiedRadioFillTimer = null;
  }

  if (reason) {
    console.log(`[verified-radio] Fill timer cancelado: reason=${reason}`);
  }
}

function createFfmpegResourceFromUrl(ytDlpResult) {
  const { userAgent, headerBlock, includedHeaderNames } = buildFfmpegHttpOptions(
    ytDlpResult.http_headers
  );
  const ffmpegArgs = [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '10',
    '-rw_timeout', '15000000',
    '-user_agent', userAgent
  ];

  if (headerBlock) {
    ffmpegArgs.push('-headers', headerBlock);
  }

  ffmpegArgs.push(
    '-i', ytDlpResult.url,
    '-analyzeduration', '0',
    '-probesize', '32',
    '-loglevel', 'warning',
    '-vn',
    '-c:a', 'pcm_s16le',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  );

  console.log('FFmpeg path:', FFMPEG_PATH);
  console.log(
    `FFmpeg input: format_id=${ytDlpResult.format_id || 'n/a'}, ` +
    `ext=${ytDlpResult.ext || 'n/a'}, protocol=${ytDlpResult.protocol || 'n/a'}, ` +
    `userAgent=${getHttpHeader(ytDlpResult.http_headers, 'User-Agent') ? 'yt-dlp' : 'fallback'}, ` +
    `headers=${includedHeaderNames.join(',') || 'ninguno'}`
  );

  const ffmpegProcess = spawn(FFMPEG_PATH, ffmpegArgs, {
    cwd: __dirname,
    windowsHide: true
  });
  const ffmpegState = {
    closed: false,
    exitCode: null,
    signal: null,
    stderr: '',
    expectedShutdown: false,
    expectedShutdownReason: null
  };

  ffmpegProcess.on('error', (error) => {
    console.error('FFmpeg process error:', sanitizeDiagnosticText(error));
    ffmpegState.error = error;
  });

  ffmpegProcess.stderr.on('data', (data) => {
    const message = sanitizeDiagnosticText(data);
    if (!message || isExpectedFfmpegShutdownLog(message, ffmpegState)) return;

    ffmpegState.stderr = `${ffmpegState.stderr}\n${message}`.slice(-4000);
    console.error(`FFmpeg stderr: ${message}`);
  });

  ffmpegProcess.on('close', (code, signal) => {
    ffmpegState.closed = true;
    ffmpegState.exitCode = code;
    ffmpegState.signal = signal || null;

    if (code && ffmpegState.expectedShutdown) {
      console.log(`FFmpeg cerrado durante cambio de pista. Code: ${code}`);
      return;
    }

    if (code) {
      console.error(`FFmpeg closed with code: ${code}${signal ? ` signal: ${signal}` : ''}`);
      if (ffmpegState.stderr.trim()) {
        console.error(`FFmpeg stderr previo al cierre:\n${sanitizeDiagnosticText(ffmpegState.stderr)}`);
      }
      return;
    }

    console.log(`FFmpeg closed with code: ${code}`);
  });

  return createAudioResource(ffmpegProcess.stdout, {
    inputType: StreamType.Raw,
    metadata: {
      ffmpegState
    }
  });
}

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guildId = oldState.guild.id || newState.guild.id;

  if (!guildId || guildId !== activeGuildId || isStopping || !hasActiveSession()) return;

  const connection = getVoiceConnection(guildId);
  if (!connection) return;

  const voiceChannelId = connection.joinConfig?.channelId;
  if (!voiceChannelId) return;

  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;

  if (oldChannelId !== voiceChannelId && newChannelId !== voiceChannelId) return;

  if (isBotAloneInVoiceChannel(guildId)) {
    startVoiceEmptyTimer(guildId);
    return;
  }

  if (voiceEmptyTimer) {
    console.log('Usuarios humanos detectados en voice. Cancelando timer corto de limpieza.');
    clearVoiceEmptyTimer();
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const url = extractPlayUrl(message.content);
  if (!url) return;

  rememberCommandMessage(message);
  clearInactivityTimer();
  clearVoiceEmptyTimer();
  clearManualPlaybackFlags();

  const channel = message.member?.voice?.channel;

  if (!channel) {
    return showPanelNotice('Join a voice channel first.', message.channel);
  }

  console.log('Mensaje recibido:', message.content);
  console.log('URL detectada:', url);
  activeGuildId = message.guild.id;

  try {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false
    });

    connection.on('error', (error) => {
      console.error('Voice connection error:', error);
    });

    connection.subscribe(player);

    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

    const song = {
      url,
      title: null,
      source: 'manual'
    };

    clearForwardStack('pedido manual nuevo');
    cancelRadioPreload('pedido manual nuevo');
    cancelRadioQueueRefill('pedido manual nuevo');

    if (isPlayerBusy()) {
      radioSeedSong = song;
      manualQueue.push(song);
      radioQueue.length = 0;
      reconcileTransportPreloadBuffer('manual-queue-changed');
      await sendOrUpdateControls(message.channel, { repost: true });

      if (currentSong?.source === 'radio') {
        isSkipping = true;
        markActivePlaybackExpectedShutdown('pedido manual sobre radio');
        player.stop();
        currentSong = null;
        isPaused = false;
        await playNextSong();
      }

      return;
    }

    isStarting = true;
    radioSeedSong = song;
    manualQueue.push(song);
    radioQueue.length = 0;
    await sendOrUpdateControls(message.channel, { repost: true });

    try {
      await playIntroIfNeeded();
      await playNextSong();
      await updateControlsMessage();
    } finally {
      isStarting = false;
      await flushPendingIdleAdvance();
      await updateControlsMessage();
    }
  } catch (error) {
    isStarting = false;
    console.error('Error al reproducir:', error);
    await updateControlsMessage();
    return showPanelNotice('Playback failed.', message.channel);
  }
});

function isCurrentControlsInteraction(interaction) {
  return Boolean(
    controlsMessage &&
    interaction.message &&
    interaction.message.id === controlsMessage.id
  );
}

async function safelyDeferButtonInteraction(interaction) {
  try {
    await interaction.deferUpdate();
    return true;
  } catch (error) {
    if (isUnknownInteractionError(error)) {
      console.warn('Interaccion expirada ignorada.');
      return false;
    }

    throw error;
  }
}

async function deleteStaleControlsMessage(interaction) {
  if (!interaction?.message?.delete) return;

  await interaction.message.delete().catch(() => {});
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (!Object.values(CONTROL_IDS).includes(interaction.customId)) return;

  let interactionDeferred = false;

  try {
    interactionDeferred = await safelyDeferButtonInteraction(interaction);
    if (!interactionDeferred) return;

    if (!isCurrentControlsInteraction(interaction)) {
      console.warn('Boton de panel viejo ignorado.');
      await deleteStaleControlsMessage(interaction);
      return;
    }

    if (interaction.customId === CONTROL_IDS.playPause) {
      if (player.state.status === AudioPlayerStatus.Playing) {
        player.pause();
        await updateControlsMessage();
        return;
      }

      if (player.state.status === AudioPlayerStatus.Paused) {
        player.unpause();
        await updateControlsMessage();
        return;
      }

      await updateControlsMessage();

      if (loadingCueState.active) {
        return sendEphemeralNotice(interaction, 'Loading...');
      }

      return sendEphemeralNotice(interaction, 'Nothing is playing.');
    }

    if (interaction.customId === CONTROL_IDS.stop) {
      await cleanupSession(interaction.guildId);
      return;
    }

    if (interaction.customId === CONTROL_IDS.next) {
      if (isAdvancing) {
        return sendEphemeralNotice(interaction, 'Loading...');
      }

      const title = await skipToNext();
      if (!title) return sendEphemeralNotice(interaction, 'No next track.');
      return;
    }

    if (interaction.customId === CONTROL_IDS.previous) {
      const title = await playPreviousSong();
      await repostControlsMessage(interaction.channel);
      if (!title) return sendEphemeralNotice(interaction, 'No previous track.');
      return;
    }

  } catch (error) {
    if (isUnknownInteractionError(error)) {
      console.warn('Interaccion expirada ignorada.');
      return;
    }

    console.error('Error manejando boton:', error);

    if (!interactionDeferred) return;

    if (interaction.deferred || interaction.replied) {
      return sendEphemeralNotice(interaction, 'Action failed.');
    }

    return interaction.reply({
      content: 'Action failed.',
      flags: MessageFlags.Ephemeral
    }).catch((replyError) => {
      if (isUnknownInteractionError(replyError)) {
        console.warn('No pude responder porque la interaccion expiro.');
        return;
      }

      console.error('No pude responder la interaction con error:', replyError);
    });
  }
});

client.login(process.env.TOKEN);
