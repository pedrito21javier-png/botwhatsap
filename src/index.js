const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const dotenv = require('dotenv');
const qrcode = require('qrcode-terminal');
const { Telegraf } = require('telegraf');
const { Client, LocalAuth } = require('whatsapp-web.js');
const {
  buildMessageKey,
  buildMessageKeys,
  detectOriginType,
  normalizeWid,
  phoneFromWid,
  resolveMessageAuthor,
  resolveRemoteWid
} = require('./message-identity');

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
const WWEBJS_AUTH_DIR = path.resolve(
  process.cwd(),
  process.env.WWEBJS_AUTH_DIR || './.wwebjs_auth'
);
const CLEANUP_INTERVAL_MINUTES = Number(process.env.CLEANUP_INTERVAL_MINUTES || 15);
const MEDIA_MAX_AGE_HOURS = Number(process.env.MEDIA_MAX_AGE_HOURS || 6);
const MEDIA_MAX_AGE_MS = MEDIA_MAX_AGE_HOURS * 60 * 60 * 1000;
const CACHE_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const MESSAGE_CACHE_RETENTION_HOURS = Number(process.env.MESSAGE_CACHE_RETENTION_HOURS || 6);
const MESSAGE_CACHE_RETENTION_MS = MESSAGE_CACHE_RETENTION_HOURS * 60 * 60 * 1000;
const MESSAGE_CACHE_MAX_ENTRIES = Number(process.env.MESSAGE_CACHE_MAX_ENTRIES || 2000);
const REPORT_STORE_RETENTION_HOURS = Number(process.env.REPORT_STORE_RETENTION_HOURS || 12);
const REPORT_STORE_RETENTION_MS = REPORT_STORE_RETENTION_HOURS * 60 * 60 * 1000;
const REPORT_STORE_MAX_ENTRIES = Number(process.env.REPORT_STORE_MAX_ENTRIES || 50);
const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_MESSAGE_LIMIT = 4096;

const PUPPETEER_ARGS = [
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
];

const MESSAGE_TYPE_LABELS = {
  audio: 'Audio',
  chat: 'Texto',
  document: 'Documento',
  image: 'Imagen',
  location: 'Ubicacion',
  ptt: 'Nota de voz',
  reaction: 'Reaccion',
  revoked: 'Revocado',
  sticker: 'Sticker',
  video: 'Video',
  vcard: 'Contacto'
};

const telegramBot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const messageCache = new Map();
const reportStore = new Map();

let whatsappClient = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function truncateEscapedHtml(value, maxLength) {
  if (maxLength <= 3) {
    return '';
  }

  let text = String(value ?? '');
  let escaped = escapeHtml(text);

  while (escaped.length > maxLength && text.length > 0) {
    const nextLength = Math.max(0, Math.floor(text.length * (maxLength / escaped.length)) - 3);
    const nextText = truncateText(text, nextLength);

    if (nextText === text) {
      return '';
    }

    text = nextText;
    escaped = escapeHtml(text);
  }

  return escaped.length <= maxLength ? escaped : '';
}

function sanitizeFileName(input) {
  return String(input).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function cleanText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function digitsOnly(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits || null;
}

function formatMessageType(type) {
  return MESSAGE_TYPE_LABELS[type] || type || 'Desconocido';
}

function resolveDisplayName(contact, phoneNumber) {
  const contactName = cleanText(contact?.name);
  const pushName = cleanText(contact?.pushname);
  const shortName = cleanText(contact?.shortName);
  const nickName = pushName || shortName || null;

  if (contactName) {
    return {
      contactName,
      displayName: contactName,
      nickName,
      nameSource: 'contacto_guardado'
    };
  }

  if (nickName) {
    return {
      contactName: null,
      displayName: nickName,
      nickName,
      nameSource: 'nick_whatsapp'
    };
  }

  if (phoneNumber) {
    return {
      contactName: null,
      displayName: phoneNumber,
      nickName: null,
      nameSource: 'numero'
    };
  }

  return {
    contactName: null,
    displayName: 'Desconocido',
    nickName: null,
    nameSource: 'desconocido'
  };
}

function formatNameSource(source) {
  const labels = {
    contacto_guardado: 'Contacto guardado',
    nick_whatsapp: 'Nick de WhatsApp',
    numero: 'Numero telefonico',
    desconocido: 'No disponible'
  };

  return labels[source] || source || 'No disponible';
}

function getLocationDetails(snapshot) {
  if (snapshot.originType === 'Grupo') {
    return snapshot.chatName || 'Grupo sin nombre';
  }

  if (snapshot.originType === 'Estado') {
    return 'Estado';
  }

  return 'Chat privado';
}

function getMediaStatus(snapshot) {
  if (!snapshot.hasMedia) {
    return 'Sin multimedia';
  }

  if (snapshot.mediaInfo?.error) {
    return `No capturada: ${snapshot.mediaInfo.error}`;
  }

  return `Capturada: ${snapshot.mediaInfo?.fileName || 'archivo temporal'}`;
}

function buildWhatsAppChatUrl(snapshot) {
  const phone = digitsOnly(snapshot.authorPhoneNumber || phoneFromWid(snapshot.author));
  return phone ? `https://wa.me/${phone}` : null;
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
      throw new Error('WhatsApp no devolvio datos para la multimedia');
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

async function buildMessageSnapshot(message, client) {
  const authorResolution = resolveMessageAuthor(message, client?.info?.wid);
  const authorWid = authorResolution.wid;
  let contact = null;

  if (authorWid && typeof client?.getContactById === 'function') {
    contact = await client.getContactById(authorWid).catch(() => null);
  }

  if (!contact) {
    contact = await message.getContact().catch(() => null);
  }

  const chat = await message.getChat().catch(() => null);
  const authorPhoneNumber =
    contact?.number ||
    phoneFromWid(authorWid) ||
    phoneFromWid(contact?.id) ||
    null;
  const { contactName, displayName, nickName, nameSource } = resolveDisplayName(contact, authorPhoneNumber);
  const body = message.body || '[Sin texto]';
  const originType = detectOriginType(message);
  const mediaInfo = await saveMediaToDisk(message);
  const keys = buildMessageKeys(message);
  const remoteWid = normalizeWid(resolveRemoteWid(message));

  return {
    key: buildMessageKey(message),
    keys,
    body,
    type: message.type || 'unknown',
    typeLabel: formatMessageType(message.type),
    author: normalizeWid(authorWid) || null,
    authorSource: authorResolution.source,
    authorPhoneNumber,
    contactName,
    displayName,
    nickName,
    nameSource,
    timestampSeconds: message.timestamp || Math.floor(Date.now() / 1000),
    chatId: remoteWid || null,
    chatName: chat?.name || null,
    originType,
    hasMedia: Boolean(message.hasMedia),
    mediaInfo,
    messageId: message?.id?.id || message?._data?.id?.id || null,
    serializedMessageId: message?.id?._serialized || message?._data?.id?._serialized || null,
    fromMe: Boolean(message?.fromMe || message?.id?.fromMe || message?._data?.id?.fromMe),
    createdAtMs: Date.now()
  };
}

function cacheSnapshot(snapshot) {
  const keys = snapshot.keys?.length ? snapshot.keys : [snapshot.key];

  for (const key of keys) {
    messageCache.set(key, snapshot);
  }

  while (messageCache.size > MESSAGE_CACHE_MAX_ENTRIES) {
    const oldestKey = messageCache.keys().next().value;
    messageCache.delete(oldestKey);
  }
}

function findSnapshotForRevoked(afterMessage, beforeMessage) {
  const lookupKeys = [
    ...(beforeMessage ? buildMessageKeys(beforeMessage) : []),
    ...(afterMessage ? buildMessageKeys(afterMessage) : [])
  ];

  for (const key of lookupKeys) {
    const snapshot = messageCache.get(key);

    if (snapshot) {
      return {
        snapshot,
        matchedKey: key,
        lookupKeys
      };
    }
  }

  return {
    snapshot: null,
    matchedKey: null,
    lookupKeys
  };
}

function formatClockFromMs(ms) {
  if (!Number.isFinite(ms)) {
    return 'No disponible';
  }

  return new Date(ms).toLocaleTimeString('es-PY', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function buildReportDetails(snapshot, deletedAtMs) {
  const sentAtMs = (snapshot.timestampSeconds || Math.floor(Date.now() / 1000)) * 1000;
  const elapsedMs = deletedAtMs - sentAtMs;
  const content = snapshot.body === '[Sin texto]' ? 'Sin texto visible' : snapshot.body;
  const contactName = snapshot.contactName || null;
  const nickName = snapshot.nickName || null;
  const authorName = contactName || nickName || snapshot.authorPhoneNumber || 'Desconocido';

  return {
    authorName,
    authorPhone: snapshot.authorPhoneNumber || phoneFromWid(snapshot.author) || 'Desconocido',
    authorWid: snapshot.author || 'No disponible',
    cacheKey: snapshot.key || snapshot.keys?.[0] || 'No disponible',
    chatId: snapshot.chatId || 'No disponible',
    contactName: contactName || 'No guardado',
    content,
    deletedAtClock: formatClockFromMs(deletedAtMs),
    deletedAtText: new Date(deletedAtMs).toLocaleString('es-PY', {
      dateStyle: 'medium',
      timeStyle: 'medium'
    }),
    elapsedText: formatElapsed(elapsedMs),
    locationDetails: getLocationDetails(snapshot),
    mediaStatus: getMediaStatus(snapshot),
    nickName: nickName || 'No disponible',
    originType: snapshot.originType || 'Desconocido',
    sentAtClock: formatClockFromMs(sentAtMs),
    sentAtText: formatTimestamp(snapshot.timestampSeconds),
    typeLabel: snapshot.typeLabel || formatMessageType(snapshot.type),
    waUrl: buildWhatsAppChatUrl(snapshot)
  };
}

function buildMainReport(snapshot, deletedAtMs, maxLength = TELEGRAM_MESSAGE_LIMIT) {
  const details = buildReportDetails(snapshot, deletedAtMs);
  const baseLines = [
    '🗑️ <b>MENSAJE ELIMINADO</b>',
    '',
    `👤 Nombre: <b>${escapeHtml(truncateText(details.authorName, 80))}</b>`,
    `🏷️ Nick: <b>${escapeHtml(truncateText(details.nickName, 80))}</b>`,
    `📱 Numero: <code>${escapeHtml(truncateText(details.authorPhone, 40))}</code>`,
    '',
    `💬 Chat: <b>${escapeHtml(truncateText(details.locationDetails, 120))}</b>`,
    `📦 Tipo: <b>${escapeHtml(truncateText(details.typeLabel, 40))}</b>`,
    `⏳ Duracion: <b>${escapeHtml(details.elapsedText)}</b>`,
    `🕒 Hora: <b>${escapeHtml(details.sentAtClock)}</b> → <b>${escapeHtml(details.deletedAtClock)}</b>`,
    '',
    '📝 <b>Contenido</b>'
  ];
  const baseText = baseLines.join('\n');
  const remaining = maxLength - baseText.length - 1;
  const content = truncateEscapedHtml(details.content, Math.max(0, remaining));

  return `${baseText}\n${content}`;
}

function createReportRecord(snapshot, deletedAtMs, revokeContext = {}) {
  return {
    id: crypto.randomBytes(8).toString('hex'),
    snapshot,
    deletedAtMs,
    cacheHit: Boolean(snapshot),
    matchedKey: revokeContext.matchedKey || null,
    lookupKeys: revokeContext.lookupKeys || [],
    createdAtMs: Date.now()
  };
}

function rememberReport(record) {
  reportStore.set(record.id, record);

  while (reportStore.size > REPORT_STORE_MAX_ENTRIES) {
    const oldestKey = reportStore.keys().next().value;
    reportStore.delete(oldestKey);
  }
}

function buildReportKeyboard(record) {
  const buttons = [];
  const waUrl = buildWhatsAppChatUrl(record.snapshot);

  if (waUrl) {
    buttons.push({
      text: 'Abrir WhatsApp',
      url: waUrl
    });
  }

  buttons.push({
    text: 'Datos tecnicos',
    callback_data: `deltech:${record.id}`
  });

  return {
    inline_keyboard: [buttons]
  };
}

async function sendStoredTelegramReport(record, chatId, options = {}) {
  const snapshot = record.snapshot;
  const hasCapturedMedia = Boolean(
    snapshot.mediaInfo?.filePath &&
    !snapshot.mediaInfo?.error &&
    fs.existsSync(snapshot.mediaInfo.filePath)
  );
  const extra = {
    parse_mode: 'HTML',
    reply_markup: buildReportKeyboard(record)
  };

  if (options.replyToMessageId) {
    extra.reply_parameters = {
      message_id: options.replyToMessageId
    };
  }

  if (!hasCapturedMedia) {
    return telegramBot.telegram.sendMessage(
      chatId,
      buildMainReport(snapshot, record.deletedAtMs, TELEGRAM_MESSAGE_LIMIT),
      extra
    );
  }

  const input = {
    source: fs.createReadStream(snapshot.mediaInfo.filePath),
    filename: snapshot.mediaInfo.fileName
  };
  const mediaExtra = {
    ...extra,
    caption: buildMainReport(snapshot, record.deletedAtMs, TELEGRAM_CAPTION_LIMIT)
  };

  if (snapshot.mediaInfo.mimetype.startsWith('image/')) {
    return telegramBot.telegram.sendPhoto(chatId, input, mediaExtra);
  }

  if (snapshot.mediaInfo.mimetype.startsWith('video/')) {
    return telegramBot.telegram.sendVideo(chatId, input, mediaExtra);
  }

  if (snapshot.mediaInfo.mimetype.startsWith('audio/')) {
    return telegramBot.telegram.sendAudio(chatId, input, mediaExtra);
  }

  return telegramBot.telegram.sendDocument(chatId, input, mediaExtra);
}

async function sendTelegramReport(snapshot, revokeContext = {}) {
  const deletedAtMs = Date.now();
  const record = createReportRecord(snapshot, deletedAtMs, revokeContext);

  rememberReport(record);
  await sendStoredTelegramReport(record, process.env.TELEGRAM_CHAT_ID);
}

function buildTechnicalReport(record) {
  const snapshot = record.snapshot;
  const details = buildReportDetails(snapshot, record.deletedAtMs);
  const lines = [
    '<b>Datos tecnicos</b>',
    '',
    `WhatsApp ID: <code>${escapeHtml(details.authorWid)}</code>`,
    `Chat ID: <code>${escapeHtml(details.chatId)}</code>`,
    `Message ID: <code>${escapeHtml(snapshot.messageId || 'No disponible')}</code>`,
    `Fuente autor: <code>${escapeHtml(snapshot.authorSource || 'No disponible')}</code>`,
    `Cache key: <code>${escapeHtml(truncateText(record.matchedKey || details.cacheKey, 160))}</code>`,
    `Media status: <code>${escapeHtml(details.mediaStatus)}</code>`
  ];

  return lines.join('\n');
}

function getTelegramContextChatId(ctx) {
  return ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id || null;
}

function isAllowedTelegramContext(ctx) {
  const chatId = getTelegramContextChatId(ctx);
  return String(chatId) === String(process.env.TELEGRAM_CHAT_ID);
}

function startTelegramBot() {
  telegramBot.launch({ dropPendingUpdates: true })
    .then(() => {
      console.log('Bot de Telegram listo para botones inline.');
    })
    .catch((error) => {
      console.error('No se pudo iniciar el polling de Telegram. Los reportes se enviaran, pero los botones no responderan hasta corregir esto:', error);
    });
}

function setupTelegramActions() {
  telegramBot.action(/^deltech:([a-f0-9]+)$/i, async (ctx) => {
    if (!isAllowedTelegramContext(ctx)) {
      await ctx.answerCbQuery('No autorizado', { show_alert: true }).catch(() => null);
      return;
    }

    const record = reportStore.get(ctx.match[1]);

    if (!record) {
      await ctx.answerCbQuery('Reporte no disponible', { show_alert: true }).catch(() => null);
      return;
    }

    await ctx.answerCbQuery('Datos tecnicos enviados').catch(() => null);
    await ctx.reply(buildTechnicalReport(record), { parse_mode: 'HTML' });
  });

  telegramBot.catch((error) => {
    console.error('Error en Telegram bot:', error);
  });
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

  for (const [id, record] of reportStore.entries()) {
    if (now - record.createdAtMs > REPORT_STORE_RETENTION_MS) {
      reportStore.delete(id);
    }
  }
}

async function bootstrap() {
  console.log('Preparando directorios temporales y sesion persistente...');
  await ensureDir(TEMP_MEDIA_DIR);
  await ensureDir(WWEBJS_AUTH_DIR);
  await cleanupOldMediaFiles();

  setInterval(cleanupOldMediaFiles, CLEANUP_INTERVAL_MINUTES * 60 * 1000);
  setInterval(cleanupOldSnapshots, CACHE_SWEEP_INTERVAL_MS);
  setupTelegramActions();

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: 'delete-alert-bot',
      dataPath: WWEBJS_AUTH_DIR
    }),
    puppeteer: {
      headless: true,
      args: PUPPETEER_ARGS
    }
  });

  whatsappClient = client;

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
      const snapshot = await buildMessageSnapshot(message, client);
      cacheSnapshot(snapshot);
    } catch (error) {
      console.error('No se pudo almacenar el mensaje en cache:', error);
    }
  });

  client.on('message_revoke_everyone', async (after, before) => {
    try {
      const revokeContext = findSnapshotForRevoked(after, before);

      if (!revokeContext.snapshot) {
        await telegramBot.telegram.sendMessage(
          process.env.TELEGRAM_CHAT_ID,
          '<b>Alerta:</b> se detecto un mensaje eliminado, pero no fue posible recuperar su contenido del cache.',
          { parse_mode: 'HTML' }
        );
        return;
      }

      await sendTelegramReport(revokeContext.snapshot, revokeContext);
    } catch (error) {
      console.error('Error al procesar mensaje eliminado:', error);

      const errorText = escapeHtml(error.message || 'Error desconocido');
      await telegramBot.telegram.sendMessage(
        process.env.TELEGRAM_CHAT_ID,
        `<b>Error al procesar un borrado:</b> ${errorText}`,
        { parse_mode: 'HTML' }
      ).catch((telegramError) => {
        console.error('Tambien fallo el aviso de error a Telegram:', telegramError);
      });
    }
  });

  startTelegramBot();

  process.once('SIGINT', async () => {
    telegramBot.stop('SIGINT');
    await client.destroy().catch(() => null);
    process.exit(0);
  });

  process.once('SIGTERM', async () => {
    telegramBot.stop('SIGTERM');
    await client.destroy().catch(() => null);
    process.exit(0);
  });

  console.log(`Iniciando WhatsApp Web. Sesion persistente: ${WWEBJS_AUTH_DIR}`);
  console.log('Si es el primer inicio o borraste .wwebjs_auth, aparecera un QR para escanear. En reinicios normales no deberia pedir QR.');
  await client.initialize();
}

bootstrap().catch((error) => {
  console.error('Error fatal al iniciar el bot:', error);
  process.exit(1);
});
