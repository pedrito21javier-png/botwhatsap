# WhatsApp Delete Alert Bot

Bot en Node.js con `whatsapp-web.js` que guarda snapshots de mensajes y reporta a Telegram cuando WhatsApp emite un evento de borrado para todos.

## Configuracion

Variables obligatorias:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Variables opcionales:

- `TEMP_MEDIA_DIR`: directorio temporal para multimedia capturada. Por defecto `./tmp/media-cache`.
- `WWEBJS_AUTH_DIR`: directorio persistente de sesion WhatsApp. Por defecto `./.wwebjs_auth`. No lo borres si quieres evitar escanear QR en cada reinicio.
- `MEDIA_MAX_AGE_HOURS`: horas para conservar multimedia temporal. Por defecto `6`.
- `MESSAGE_CACHE_RETENTION_HOURS`: horas para conservar snapshots en memoria. Por defecto `6`.
- `MESSAGE_CACHE_MAX_ENTRIES`: maximo de claves en cache. Por defecto `2000`.
- `REPORT_STORE_RETENTION_HOURS`: horas para conservar reportes accionables con botones. Por defecto `12`.
- `REPORT_STORE_MAX_ENTRIES`: maximo de reportes accionables en memoria. Por defecto `50`.
- `CLEANUP_INTERVAL_MINUTES`: intervalo de limpieza de archivos. Por defecto `15`.

## Mensajes eliminados en grupos

En `whatsapp-web.js`, `message_revoke_everyone` entrega dos objetos:

- `after`: el mensaje ya convertido a tipo `revoked`.
- `before`: el mensaje original si la libreria todavia lo tiene disponible.

En grupos, el chat remoto normalmente es `...@g.us`. El numero real del autor no debe tomarse de `from`, porque `from` apunta al grupo. El autor del mensaje eliminado puede venir en estas rutas, segun el tipo de evento y la version interna de WhatsApp Web:

- `message.author`
- `message.id.participant`
- `message._data.id.participant`
- `message._data.protocolMessageKey.participant`
- el ultimo segmento del ID serializado: `false_<grupo>_<id>_<autor>`

El bot normaliza esas rutas en `src/message-identity.js` y guarda varias claves equivalentes para que el snapshot original pueda encontrarse aunque el evento de revocacion llegue con otra forma de ID.

## Reporte de Telegram

El reporte evita repetir el numero y resuelve el nombre con esta prioridad:

1. Nombre guardado en contactos.
2. Nick/pushname de WhatsApp.
3. Numero telefonico.

Cada alerta envia un solo contenedor:

- Si el mensaje eliminado era texto, se envia un unico mensaje con el reporte principal.
- Si tenia multimedia y el bot la capturo, se envia la multimedia con el reporte principal como caption.
- El boton `Abrir WhatsApp` abre el chat del autor del mensaje eliminado.
- El boton `Datos tecnicos` muestra WhatsApp ID, Chat ID, Message ID, fuente del autor, cache key y estado de media.

## Sesion de WhatsApp

El bot usa `LocalAuth` con sesion persistente en `.wwebjs_auth/session-delete-alert-bot`. Debes escanear el QR solo la primera vez, o cuando borres esa carpeta, cambies de cuenta, cierres sesion desde WhatsApp, o WhatsApp invalide la sesion.

Si ves errores de `SingletonCookie`, borra solo la sesion corrupta y escanea una vez:

```bash
rm -rf .wwebjs_auth/session-delete-alert-bot
npm start
```


## Oracle Cloud Free

Para una instancia de 1 GB RAM, usa swap y PM2:

```bash
cd /home/ubuntu/botwhatsap
chmod +x scripts/oracle-free-setup.sh
./scripts/oracle-free-setup.sh
npm install
npm run pm2:start
pm2 save
pm2 startup
```

El script crea un swapfile de 2 GB por defecto, lo persiste en `/etc/fstab` y configura `vm.swappiness=20`. Puedes ajustar valores asi:

```bash
SWAP_SIZE=3G SWAPPINESS=10 ./scripts/oracle-free-setup.sh
```

Para reiniciar el bot despues de cambios:

```bash
npm run restart
```

## Comandos

- `npm start`: inicia el bot.
- `npm test`: ejecuta pruebas de parsing de identidad y claves de revocacion.
- `npm run pm2:start`: inicia el bot con PM2 usando el perfil liviano.
- `npm run restart`: reinicia el bot en PM2, o lo inicia si no existe.
