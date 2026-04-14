const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildMessageKeys,
  detectOriginType,
  phoneFromWid,
  resolveMessageAuthor,
  resolveMessageAuthorWid
} = require('../src/message-identity');

test('detects group messages from the remote chat id', () => {
  const message = {
    from: '120363000000000000@g.us',
    id: {
      id: 'ABC',
      remote: '120363000000000000@g.us'
    }
  };

  assert.equal(detectOriginType(message), 'Grupo');
});

test('resolves group author from message.author', () => {
  const message = {
    from: '120363000000000000@g.us',
    author: '595981111111@c.us',
    id: {
      id: 'ABC',
      remote: '120363000000000000@g.us'
    }
  };

  assert.equal(resolveMessageAuthorWid(message), '595981111111@c.us');
  assert.equal(phoneFromWid(resolveMessageAuthorWid(message)), '595981111111');
});

test('resolves group author from id.participant when author is missing', () => {
  const message = {
    from: '120363000000000000@g.us',
    id: {
      id: 'ABC',
      remote: '120363000000000000@g.us',
      participant: '595982222222@s.whatsapp.net'
    }
  };

  assert.equal(resolveMessageAuthorWid(message), '595982222222@c.us');
});

test('resolves revoked group author from protocolMessageKey.participant', () => {
  const revokedMessage = {
    from: '120363000000000000@g.us',
    type: 'revoked',
    _data: {
      protocolMessageKey: {
        remoteJid: '120363000000000000@g.us',
        id: 'ABC',
        fromMe: false,
        participant: '595983333333@s.whatsapp.net'
      }
    },
    id: {
      id: 'ABC',
      remote: '120363000000000000@g.us'
    }
  };

  assert.equal(resolveMessageAuthorWid(revokedMessage), '595983333333@c.us');
});


test('prefers revoked protocol participant over revoke actor fields', () => {
  const revokedMessage = {
    from: '120363000000000000@g.us',
    author: '595980000000@c.us',
    type: 'revoked',
    _data: {
      protocolMessageKey: {
        remoteJid: '120363000000000000@g.us',
        id: 'ABC',
        fromMe: false,
        participant: '595985555555@s.whatsapp.net'
      }
    },
    id: {
      id: 'ABC',
      remote: '120363000000000000@g.us'
    }
  };

  assert.equal(resolveMessageAuthorWid(revokedMessage), '595985555555@c.us');
});


test('returns the source used to resolve the deleted message author', () => {
  const revokedMessage = {
    from: '120363000000000000@g.us',
    author: '595980000000@c.us',
    type: 'revoked',
    _data: {
      protocolMessageKey: {
        remoteJid: '120363000000000000@g.us',
        id: 'ABC',
        fromMe: false,
        participant: '595985555555@s.whatsapp.net'
      }
    }
  };

  assert.deepEqual(resolveMessageAuthor(revokedMessage), {
    wid: '595985555555@c.us',
    source: 'protocolMessageKey.participant'
  });
});

test('matches cached original message keys with revoked protocol keys', () => {
  const originalMessage = {
    from: '120363000000000000@g.us',
    author: '595984444444@c.us',
    id: {
      fromMe: false,
      id: '3EB012345678',
      remote: '120363000000000000@g.us',
      participant: '595984444444@c.us',
      _serialized: 'false_120363000000000000@g.us_3EB012345678_595984444444@c.us'
    }
  };
  const revokedMessage = {
    from: '120363000000000000@g.us',
    type: 'revoked',
    _data: {
      protocolMessageKey: {
        remoteJid: '120363000000000000@g.us',
        id: '3EB012345678',
        fromMe: false,
        participant: '595984444444@s.whatsapp.net'
      }
    },
    id: {
      fromMe: false,
      id: '3EB012345678',
      remote: '120363000000000000@g.us'
    }
  };

  const originalKeys = new Set(buildMessageKeys(originalMessage));
  const revokedKeys = buildMessageKeys(revokedMessage);

  assert.ok(revokedKeys.some((key) => originalKeys.has(key)));
});
