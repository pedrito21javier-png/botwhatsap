const crypto = require('crypto');

function serializeWid(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (typeof value !== 'object') {
    return null;
  }

  if (typeof value._serialized === 'string') {
    return value._serialized;
  }

  if (typeof value.serialized === 'string') {
    return value.serialized;
  }

  if (typeof value.id === 'string' && value.id.includes('@')) {
    return value.id;
  }

  if (value.id && typeof value.id === 'object' && value.id !== value) {
    return serializeWid(value.id);
  }

  if (value.user && value.server) {
    return `${value.user}@${value.server}`;
  }

  return null;
}

function normalizeWid(value) {
  const wid = serializeWid(value);

  if (!wid) {
    return null;
  }

  const atIndex = wid.lastIndexOf('@');
  if (atIndex === -1) {
    return wid;
  }

  const user = wid.slice(0, atIndex);
  const server = wid.slice(atIndex + 1);
  const normalizedServer = server === 's.whatsapp.net' ? 'c.us' : server;

  return `${user}@${normalizedServer}`;
}

function pickWid(...values) {
  for (const value of values) {
    const wid = normalizeWid(value);

    if (wid) {
      return wid;
    }
  }

  return null;
}

function pickWidWithSource(candidates) {
  for (const candidate of candidates) {
    const wid = normalizeWid(candidate.value);

    if (wid) {
      return {
        wid,
        source: candidate.source
      };
    }
  }

  return {
    wid: null,
    source: null
  };
}

function getServer(value) {
  const wid = normalizeWid(value);
  const atIndex = wid?.lastIndexOf('@') ?? -1;

  if (atIndex === -1) {
    return null;
  }

  return wid.slice(atIndex + 1);
}

function isGroupWid(value) {
  return getServer(value) === 'g.us';
}

function isStatusWid(value) {
  const wid = normalizeWid(value);
  return wid === 'status@broadcast' || getServer(wid) === 'broadcast';
}

function isUserWid(value) {
  return getServer(value) === 'c.us';
}

function phoneFromWid(value) {
  const wid = normalizeWid(value);

  if (!wid || !isUserWid(wid)) {
    return null;
  }

  const atIndex = wid.lastIndexOf('@');
  return wid.slice(0, atIndex).split(':')[0] || null;
}

function getMessageIdData(message) {
  return message?.id || message?._data?.id || {};
}

function getProtocolMessageKey(message) {
  const data = message?._data || {};

  return (
    data.protocolMessageKey ||
    data.protocolMsgKey ||
    data.protocolMessage?.key ||
    data.message?.protocolMessage?.key ||
    data.msg?.protocolMessageKey ||
    null
  );
}

function extractParticipantFromSerializedId(serialized) {
  if (typeof serialized !== 'string') {
    return null;
  }

  const match = serialized.match(/_([^_]+@(?:c\.us|s\.whatsapp\.net|lid))$/);
  return match ? normalizeWid(match[1]) : null;
}

function resolveRemoteWid(message) {
  const id = getMessageIdData(message);
  const data = message?._data || {};
  const protocolKey = getProtocolMessageKey(message);

  return pickWid(
    message?.from,
    data.from,
    data.remote,
    id.remote,
    data.id?.remote,
    protocolKey?.remoteJid,
    protocolKey?.remote,
    message?.to
  );
}

function detectOriginType(message) {
  const remote = resolveRemoteWid(message);

  if (
    message?.isStatus ||
    message?.broadcast ||
    isStatusWid(remote) ||
    isStatusWid(message?.from)
  ) {
    return 'Estado';
  }

  if (isGroupWid(remote) || isGroupWid(message?.from) || isGroupWid(message?.to)) {
    return 'Grupo';
  }

  return 'Privado';
}

function resolveMessageAuthor(message, selfWid) {
  const originType = detectOriginType(message);
  const id = getMessageIdData(message);
  const data = message?._data || {};
  const protocolKey = getProtocolMessageKey(message);
  const serializedId = id._serialized || data.id?._serialized;
  const fromMe = Boolean(message?.fromMe || id.fromMe || protocolKey?.fromMe);

  if (originType === 'Grupo') {
    return pickWidWithSource([
      { source: 'protocolMessageKey.participant', value: protocolKey?.participant },
      { source: 'message.author', value: message?.author },
      { source: '_data.author', value: data.author },
      { source: 'id.participant', value: id.participant },
      { source: '_data.id.participant', value: data.id?.participant },
      { source: '_data.participant', value: data.participant },
      { source: 'id._serialized', value: extractParticipantFromSerializedId(serializedId) },
      { source: 'client.info.wid', value: fromMe ? selfWid : null }
    ]);
  }

  if (fromMe) {
    return pickWidWithSource([
      { source: 'client.info.wid', value: selfWid },
      { source: '_data.sender.id', value: data.sender?.id },
      { source: '_data.sender', value: data.sender }
    ]);
  }

  return pickWidWithSource([
    { source: 'message.author', value: message?.author },
    { source: '_data.author', value: data.author },
    { source: 'message.from', value: message?.from },
    { source: '_data.from', value: data.from },
    { source: 'id.remote', value: id.remote },
    { source: '_data.remote', value: data.remote }
  ]);
}

function resolveMessageAuthorWid(message, selfWid) {
  return resolveMessageAuthor(message, selfWid).wid;
}

function buildSerializedMessageId(fromMe, remote, id, participant) {
  const remoteWid = normalizeWid(remote);

  if (typeof fromMe !== 'boolean' || !remoteWid || !id) {
    return null;
  }

  const prefix = fromMe ? 'true' : 'false';
  const authorWid = normalizeWid(participant);

  if (isGroupWid(remoteWid) && authorWid) {
    return `${prefix}_${remoteWid}_${id}_${authorWid}`;
  }

  return `${prefix}_${remoteWid}_${id}`;
}

function buildCanonicalMessageKey(remote, id, participant) {
  const remoteWid = normalizeWid(remote);

  if (!remoteWid || !id) {
    return null;
  }

  return `${remoteWid}|${id}|${normalizeWid(participant) || ''}`;
}

function addKey(keys, value) {
  if (value) {
    keys.add(value);
  }
}

function buildMessageKeys(message) {
  const keys = new Set();
  const id = getMessageIdData(message);
  const data = message?._data || {};
  const protocolKey = getProtocolMessageKey(message);
  const remote = resolveRemoteWid(message);
  const author = resolveMessageAuthorWid(message);

  addKey(keys, id._serialized);
  addKey(keys, data.id?._serialized);

  addKey(
    keys,
    buildSerializedMessageId(
      id.fromMe,
      id.remote || data.remote || message?.from || remote,
      id.id,
      id.participant || data.id?.participant || author
    )
  );
  addKey(
    keys,
    buildCanonicalMessageKey(
      id.remote || data.remote || message?.from || remote,
      id.id,
      id.participant || data.id?.participant || author
    )
  );

  if (protocolKey) {
    const protocolRemote = protocolKey.remoteJid || protocolKey.remote || remote;
    const protocolParticipant = protocolKey.participant || author;

    addKey(
      keys,
      buildSerializedMessageId(
        protocolKey.fromMe,
        protocolRemote,
        protocolKey.id,
        protocolParticipant
      )
    );
    addKey(
      keys,
      buildCanonicalMessageKey(protocolRemote, protocolKey.id, protocolParticipant)
    );
  }

  return Array.from(keys);
}

function buildMessageKey(message) {
  const [key] = buildMessageKeys(message);

  if (key) {
    return key;
  }

  const fallback = `${message?.from || 'unknown'}:${message?.timestamp || Date.now()}:${message?.body || ''}`;
  return crypto.createHash('sha1').update(fallback).digest('hex');
}

module.exports = {
  buildMessageKey,
  buildMessageKeys,
  detectOriginType,
  getProtocolMessageKey,
  normalizeWid,
  phoneFromWid,
  resolveMessageAuthor,
  resolveMessageAuthorWid,
  resolveRemoteWid
};
