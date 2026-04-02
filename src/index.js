const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const dotenv = require('dotenv');
const qrcode = require('qrcode-terminal');
const { Telegraf } = require('telegraf');
const { Client, LocalAuth } = require('whatsapp-web.js');

dotenv.config();

const REQUIRED_ENV_VARS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];

for (const envKey of REQUIRED_ENV_VARS) {
  if (!process.env[envKey]) {
    throw new Error(`Falta la variable de entorno obligatoria: ${envKey}`);
  }
}

const TEMP_MEDIA_DIR = path.resolve(
  process.cwd(),
  process.env.TEMP_MEDIA_DIR || './tmp/media-cache'
);
const CLEANUP_INTERVAL_MINUTES = Number(process.env.CLEANUP_INTERVAL_MINUTES || 30);
const MEDIA_MAX_AGE_HOURS = Number(process.env.MEDIA_MAX_AGE_HOURS || 24);
const MEDIA_MAX_AGE_MS = MEDIA_MAX_AGE_HOURS * 60 * 60 * 1000;
const CACHE_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const MESSAGE_CACHE_RETENTION_HOURS = Number(process.env.MESSAGE_CACHE_RETENTION_HOURS || 24);
const MESSAGE_CACHE_RETENTION_MS = MESSAGE_CACHE_RETENTION_HOURS * 60 * 60 * 1000;
const TELEGRAM_CAPTION_LIMIT = 1024;

const telegramBot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const messageCache = new Map();

function escapeMarkdownV2(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function formatTimestamp(timestampSeconds) {
  if (!timestampSeconds) {
    return 'Desconocida';
  }

  return new Date(timestampSeconds * 1000).toLocaleString('es-PY', {
    dateStyle: 'medium',
    timeStyle: 'medium'
  });
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return 'No disponible';
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function truncateText(value, maxLength) {
  const text = String(value ?? '');
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function detectOriginType(message) {
  const remote = message?._data?.remote;

  if (
    message?.isStatus ||
    message?.broadcast ||
    remote === 'status@broadcast' ||
    message?.from === 'status@broadcast'
  ) {
    return 'Estado';
  }

  if (message?.from?.endsWith('@g.us') || message?.to?.endsWith('@g.us')) {
    return 'Grupo';
  }

  return 'Privado';
}

function sanitizeFileName(input) {
  return String(input).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function buildMessageKey(message) {
  const serialized = message?.id?._serialized || message?.id?.id;
  if (serialized) {
    return serialized;
  }

  const fallback = `${message?.from || 'unknown'}:${message?.timestamp || Date.now()}:${message?.body || ''}`;
  return crypto.createHash('sha1').update(fallback).digest('hex');
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function saveMediaToDisk(message) {
  if (!message?.hasMedia) {
    return null;
  }

  try {
    const media = await message.downloadMedia();

    if (!media?.data) {
      throw new Error('WhatsApp no devolvió datos para la multimedia');
    }

    const extension = media.mimetype?.split('/')[1]?.split(';')[0] || 'bin';
    const fileName = sanitizeFileName(
      `${Date.now()}_${message.id?.id || crypto.randomUUID()}.${extension}`
    );
    const filePath = path.join(TEMP_MEDIA_DIR, fileName);

    await fsp.writeFile(filePath, Buffer.from(media.data, 'base64'));

    return {
      filePath,
      mimetype: media.mimetype || 'application/octet-stream',
      fileName,
      sizeBytes: Buffer.byteLength(media.data, 'base64')
    };
  } catch (error) {
    console.error('Error al descargar o guardar multimedia:', error);
    return {
      error: error.message || 'Error desconocido al capturar multimedia'
    };
  }
}

async function buildMessageSnapshot(message) {
  const contact = await message.getContact().catch(() => null);
  const chat = await message.getChat().catch(() => null);
  const displayName =
    contact?.pushname ||
    contact?.name ||
    contact?.shortName ||
    chat?.name ||
    'Desconocido';
  const phoneNumber = contact?.number || (contact?.id?.user ?? 'Desconocido');
  const body = message.body || '[Sin texto]';
  const originType = detectOriginType(message);
  const mediaInfo = await saveMediaToDisk(message);

  return {
    key: buildMessageKey(message),
    body,
    type: message.type || 'unknown',
    author: message.author || null,
    timestampSeconds: message.timestamp || Math.floor(Date.now() / 1000),
    displayName,
    phoneNumber,
    chatName: chat?.name || null,
    originType,
    hasMedia: Boolean(message.hasMedia),
    mediaInfo,
    createdAtMs: Date.now()
  };
}

function cacheSnapshot(snapshot) {
  messageCache.set(snapshot.key, snapshot);
}

function getSnapshotForRevoked(afterMessage, beforeMessage) {
  const beforeKey = beforeMessage ? buildMessageKey(beforeMessage) : null;
  const afterKey = afterMessage ? buildMessageKey(afterMessage) : null;

  return (
    (beforeKey && messageCache.get(beforeKey)) ||
    (afterKey && messageCache.get(afterKey)) ||
    null
  );
}

function buildTelegramReport(snapshot, deletedAtMs) {
  const sentAtMs = (snapshot.timestampSeconds || Math.floor(Date.now() / 1000)) * 1000;
  const elapsedMs = deletedAtMs - sentAtMs;
  const deletedAtText = new Date(deletedAtMs).toLocaleString('es-PY', {
    dateStyle: 'medium',
    timeStyle: 'medium'
  });
  const locationDetails =
    snapshot.originType === 'Grupo'
      ? snapshot.chatName || 'Grupo sin nombre'
      : snapshot.originType === 'Estado'
        ? 'Estado'
        : 'Chat privado';
  const mediaStatus = snapshot.hasMedia
    ? snapshot.mediaInfo?.error
      ? `Fallida: ${snapshot.mediaInfo.error}`
      : `Capturada: ${snapshot.mediaInfo.fileName}`
    : 'Sin multimedia';
  const participant = snapshot.author ? snapshot.author.replace('@c.us', '') : null;
  const content = snapshot.body === '[Sin texto]' ? '_Sin texto visible_' : escapeMarkdownV2(snapshot.body);

  const lines = [
    '🚨 *ALERTA DE MENSAJE ELIMINADO*',
    '_Se recupero el contenido antes de que desapareciera del chat_',
    '',
    '• *IDENTIDAD*',
    `👤 Nombre: *${escapeMarkdownV2(snapshot.displayName)}*`,
    `📱 Numero: \`${escapeMarkdownV2(snapshot.phoneNumber)}\``,
    participant ? `🧾 Autor en grupo: \`${escapeMarkdownV2(participant)}\`` : null,
    '',
    '• *CONTEXTO*',
    `📍 Origen: *${escapeMarkdownV2(snapshot.originType)}*`,
    `🧭 Ubicacion: *${escapeMarkdownV2(locationDetails)}*`,
    `🗂️ Tipo: \`${escapeMarkdownV2(snapshot.type)}\``,
    `💾 Multimedia: ${escapeMarkdownV2(mediaStatus)}`,
    '',
    '• *TIEMPOS*',
    `🕒 Enviado: ${escapeMarkdownV2(formatTimestamp(snapshot.timestampSeconds))}`,
    `🗑️ Eliminado: ${escapeMarkdownV2(deletedAtText)}`,
    `⏳ Tiempo transcurrido: *${escapeMarkdownV2(formatElapsed(elapsedMs))}*`,
    '',
    '• *CONTENIDO RECUPERADO*',
    content
  ].filter(Boolean);

  return lines.join('\n');
}

function buildTelegramCaption(snapshot, deletedAtMs) {
  const sentAtMs = (snapshot.timestampSeconds || Math.floor(Date.now() / 1000)) * 1000;
  const elapsedMs = deletedAtMs - sentAtMs;
  const locationDetails =
    snapshot.originType === 'Grupo'
      ? snapshot.chatName || 'Grupo sin nombre'
      : snapshot.originType === 'Estado'
        ? 'Estado'
        : 'Chat privado';
  const participant = snapshot.author ? snapshot.author.replace('@c.us', '') : null;
  const baseLines = [
    '🚨 *ALERTA DE MENSAJE ELIMINADO*',
    `👤 *${escapeMarkdownV2(snapshot.displayName)}*`,
    `📱 \`${escapeMarkdownV2(snapshot.phoneNumber)}\``,
    participant ? `🧾 \`${escapeMarkdownV2(participant)}\`` : null,
    `📍 *${escapeMarkdownV2(snapshot.originType)}* \\| ${escapeMarkdownV2(locationDetails)}`,
    `🗂️ \`${escapeMarkdownV2(snapshot.type)}\` \\| ⏳ *${escapeMarkdownV2(formatElapsed(elapsedMs))}*`,
    '',
    '📝 *Contenido recuperado:*'
  ].filter(Boolean);
  const baseText = baseLines.join('\n');
  const remaining = TELEGRAM_CAPTION_LIMIT - baseText.length - 1;
  const visibleBody = snapshot.body === '[Sin texto]' ? 'Sin texto visible' : snapshot.body;
  const content = escapeMarkdownV2(truncateText(visibleBody, Math.max(0, remaining)));
  return `${baseText}\n${content}`;
}

async function sendTelegramReport(snapshot) {
  const deletedAtMs = Date.now();
  const report = buildTelegramReport(snapshot, deletedAtMs);

  if (!snapshot.mediaInfo?.filePath || snapshot.mediaInfo?.error) {
    await telegramBot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, report, {
      parse_mode: 'MarkdownV2'
    });
    return;
  }

  const input = {
    source: fs.createReadStream(snapshot.mediaInfo.filePath),
    filename: snapshot.mediaInfo.fileName
  };

  const extra = {
    caption: buildTelegramCaption(snapshot, deletedAtMs),
    parse_mode: 'MarkdownV2'
  };
  let mediaMessage;

  if (snapshot.mediaInfo.mimetype.startsWith('image/')) {
    mediaMessage = await telegramBot.telegram.sendPhoto(process.env.TELEGRAM_CHAT_ID, input, extra);
  } else if (snapshot.mediaInfo.mimetype.startsWith('video/')) {
    mediaMessage = await telegramBot.telegram.sendVideo(process.env.TELEGRAM_CHAT_ID, input, extra);
  } else if (snapshot.mediaInfo.mimetype.startsWith('audio/')) {
    mediaMessage = await telegramBot.telegram.sendAudio(process.env.TELEGRAM_CHAT_ID, input, extra);
  } else {
    mediaMessage = await telegramBot.telegram.sendDocument(process.env.TELEGRAM_CHAT_ID, input, extra);
  }

  if (report.length > TELEGRAM_CAPTION_LIMIT) {
    await telegramBot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, report, {
      parse_mode: 'MarkdownV2',
      reply_parameters: {
        message_id: mediaMessage.message_id
      }
    }).catch(() => {
      return telegramBot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, report, {
        parse_mode: 'MarkdownV2'
      });
    });
  }
}

async function cleanupOldMediaFiles() {
  try {
    await ensureDir(TEMP_MEDIA_DIR);
    const entries = await fsp.readdir(TEMP_MEDIA_DIR, { withFileTypes: true });
    const now = Date.now();

    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const filePath = path.join(TEMP_MEDIA_DIR, entry.name);
          const stats = await fsp.stat(filePath);
          const ageMs = now - stats.mtimeMs;

          if (ageMs > MEDIA_MAX_AGE_MS) {
            await fsp.unlink(filePath).catch((error) => {
              console.error(`No se pudo eliminar el archivo ${filePath}:`, error);
            });
          }
        })
    );
  } catch (error) {
    console.error('Error durante la limpieza de archivos temporales:', error);
  }
}

function cleanupOldSnapshots() {
  const now = Date.now();

  for (const [key, snapshot] of messageCache.entries()) {
    if (now - snapshot.createdAtMs > MESSAGE_CACHE_RETENTION_MS) {
      messageCache.delete(key);
    }
  }
}

async function bootstrap() {
  await ensureDir(TEMP_MEDIA_DIR);
  await cleanupOldMediaFiles();

  setInterval(cleanupOldMediaFiles, CLEANUP_INTERVAL_MINUTES * 60 * 1000);
  setInterval(cleanupOldSnapshots, CACHE_SWEEP_INTERVAL_MS);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: 'delete-alert-bot'
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-first-run',
        '--no-zygote'
      ]
    }
  });

  client.on('qr', (qr) => {
    console.log('Escanea este QR con WhatsApp para iniciar la sesion:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    console.log('Cliente de WhatsApp listo.');
  });

  client.on('authenticated', () => {
    console.log('Sesion autenticada correctamente.');
  });

  client.on('auth_failure', (message) => {
    console.error('Fallo de autenticacion:', message);
  });

  client.on('disconnected', (reason) => {
    console.warn('WhatsApp se desconecto:', reason);
  });

  client.on('message_create', async (message) => {
    try {
      const snapshot = await buildMessageSnapshot(message);
      cacheSnapshot(snapshot);
    } catch (error) {
      console.error('No se pudo almacenar el mensaje en cache:', error);
    }
  });

  client.on('message_revoke_everyone', async (after, before) => {
    try {
      const snapshot = getSnapshotForRevoked(after, before);

      if (!snapshot) {
        await telegramBot.telegram.sendMessage(
          process.env.TELEGRAM_CHAT_ID,
          '*Alerta:* se detecto un mensaje eliminado, pero no fue posible recuperar su contenido del cache\\.',
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      await sendTelegramReport(snapshot);
    } catch (error) {
      console.error('Error al procesar mensaje eliminado:', error);

      const errorText = escapeMarkdownV2(error.message || 'Error desconocido');
      await telegramBot.telegram.sendMessage(
        process.env.TELEGRAM_CHAT_ID,
        `*Error al procesar un borrado:* ${errorText}`,
        { parse_mode: 'MarkdownV2' }
      ).catch((telegramError) => {
        console.error('Tambien fallo el aviso de error a Telegram:', telegramError);
      });
    }
  });

  await client.initialize();
}

bootstrap().catch((error) => {
  console.error('Error fatal al iniciar el bot:', error);
  process.exit(1);
});
