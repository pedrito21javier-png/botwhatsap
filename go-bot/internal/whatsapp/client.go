package whatsapp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/user/whatsapp-delete-alert-bot/internal/cache"
	"github.com/user/whatsapp-delete-alert-bot/pkg/utils"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

type Client struct {
	client       *whatsmeow.Client
	messageCache *cache.MessageCache
	reportStore  *cache.ReportStore
	tempMediaDir string
	telegramBot  interface {
		SendReport(snapshot *cache.MessageSnapshot, lookupKeys []string, matchedKey string) error
	}
}

func NewClient(messageCache *cache.MessageCache, reportStore *cache.ReportStore, tempMediaDir string, telegramBot interface{ SendReport(*cache.MessageSnapshot, []string, string) error }) *Client {
	return &Client{
		messageCache: messageCache,
		reportStore:  reportStore,
		tempMediaDir: tempMediaDir,
		telegramBot:  telegramBot,
	}
}

func (c *Client) Connect(ctx context.Context) error {
	dbLog := waLog.Stdout("Database", "DEBUG", true)
	container, err := store.NewSQLiteStore(dbLog)
	if err != nil {
		return fmt.Errorf("error al crear la base de datos: %w", err)
	}

	clientLog := waLog.Stdout("Client", "DEBUG", true)
	jid, ok := container.GetFirstDevice()
	if !ok {
		log.Println("No hay sesión guardada. Deberás escanear el código QR.")
	}

	c.client = whatsmeow.NewClient(jid, container, clientLog)
	c.client.AddEventHandler(c.handleEvent)

	if c.client.Store.ID == nil {
		qrChan, err := c.client.GetQRChannel(ctx)
		if err != nil {
			return fmt.Errorf("error al obtener canal QR: %w", err)
		}

		if err := c.client.Connect(); err != nil {
			return fmt.Errorf("error al conectar: %w", err)
		}

		for evt := range qrChan {
			if evt.Event == "code" {
				c.printQR(evt.Code)
			} else if evt.Event == "success" {
				log.Println("Sesión autenticada correctamente.")
			}
		}
	} else {
		if err := c.client.Connect(); err != nil {
			return fmt.Errorf("error al conectar: %w", err)
		}
		log.Println("Cliente de WhatsApp listo.")
	}

	return nil
}

func (c *Client) printQR(code string) {
	log.Println("Escanea este QR con WhatsApp para iniciar la sesión:")
	c.printASCIIQR(code)
}

func (c *Client) printASCIIQR(code string) {
	const (
		QRModuleSize = 1
		QRQuietZone  = 4
	)

	parts := strings.Split(code, ":")
	if len(parts) < 4 {
		log.Println(code)
		return
	}

	data := parts[3]
	size := len(data) / 2

	fmt.Println("+-----------------+")
	fmt.Println("|  ESCANEA ESTE QR |")
	fmt.Println("+-----------------+")
	fmt.Printf("Datos: %s...\n", data[:min(20, len(data))])
	fmt.Println("(QR simplificado - usa el cliente oficial)")
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (c *Client) handleEvent(evt interface{}) {
	switch v := evt.(type) {
	case *events.Message:
		c.handleMessage(v)
	case *events.Revoke:
		c.handleRevoke(v)
	}
}

func (c *Client) handleMessage(evt *events.Message) {
	snapshot := c.buildMessageSnapshot(evt)
	c.cacheSnapshot(snapshot)
}

func (c *Client) handleRevoke(evt *events.Revoke) {
	snapshot, matchedKey, lookupKeys := c.findSnapshotForRevoked(evt.DeleteKey)

	if snapshot == nil {
		c.telegramBot.SendReport(nil, lookupKeys, "")
		return
	}

	c.telegramBot.SendReport(snapshot, lookupKeys, matchedKey)
}

func (c *Client) buildMessageSnapshot(evt *events.Message) *cache.MessageSnapshot {
	message := evt.Message
	timestamp := evt.Timestamp.Unix()
	now := time.Now().UnixMilli()

	author := c.resolveAuthor(evt)
	chatID := c.resolveChatID(evt)
	chatName := c.resolveChatName(evt)
	originType := c.detectOriginType(evt)

	body := "[Sin texto]"
	if message.Conversation != nil {
		body = *message.Conversation
	} else if message.ExtendedTextMessage != nil && message.ExtendedTextMessage.Text != nil {
		body = *message.ExtendedTextMessage.Text
	}

	hasMedia := message.ImageMessage != nil ||
		message.VideoMessage != nil ||
		message.AudioMessage != nil ||
		message.DocumentMessage != nil ||
		message.StickerMessage != nil

	var mediaInfo *cache.MediaInfo
	if hasMedia {
		mediaInfo = c.saveMediaToDisk(evt)
	}

	key := c.buildMessageKey(evt)
	keys := c.buildMessageKeys(evt)

	contactName := ""
	nickName := ""
	displayName := ""
	nameSource := ""

	if author.User != "" {
		phone := author.User
		displayName, nickName, nameSource = utils.ResolveDisplayName(contactName, "", "", phone)
	} else {
		displayName = "Desconocido"
		nameSource = "desconocido"
	}

	return &cache.MessageSnapshot{
		Key:               key,
		Keys:              keys,
		Body:              body,
		Type:              c.getMessageType(message),
		TypeLabel:         utils.FormatMessageType(c.getMessageType(message)),
		Author:            author.String(),
		AuthorSource:      "mensaje_directo",
		AuthorPhoneNumber: author.User,
		ContactName:       contactName,
		DisplayName:       displayName,
		NickName:          nickName,
		NameSource:        nameSource,
		TimestampSeconds:  timestamp,
		ChatID:            chatID.String(),
		ChatName:          chatName,
		OriginType:        originType,
		HasMedia:          hasMedia,
		MediaInfo:         mediaInfo,
		MessageID:         evt.ID,
		FromMe:            evt.Info.IsFromMe,
		CreatedAtMs:       now,
	}
}

func (c *Client) resolveAuthor(evt *events.Message) types.JID {
	if evt.Info.IsGroup {
		return evt.Info.Sender
	}
	if evt.Info.IsFromMe {
		return c.client.Store.ID.ToNonAD()
	}
	return evt.Info.Chat.ToNonAD()
}

func (c *Client) resolveChatID(evt *events.Message) types.JID {
	return evt.Info.Chat
}

func (c *Client) resolveChatName(evt *events.Message) string {
	if !evt.Info.IsGroup {
		return ""
	}

	groupInfo, err := c.client.GetGroupInfo(evt.Info.Chat)
	if err != nil {
		return ""
	}
	return groupInfo.Name
}

func (c *Client) detectOriginType(evt *events.Message) string {
	if evt.Info.IsStatus {
		return "Estado"
	}
	if evt.Info.IsGroup {
		return "Grupo"
	}
	return "Privado"
}

func (c *Client) getMessageType(msg *types.Message) string {
	if msg.Conversation != nil || msg.ExtendedTextMessage != nil {
		return "chat"
	}
	if msg.ImageMessage != nil {
		return "image"
	}
	if msg.VideoMessage != nil {
		return "video"
	}
	if msg.AudioMessage != nil {
		if msg.AudioMessage.PTT != nil && *msg.AudioMessage.PTT {
			return "ptt"
		}
		return "audio"
	}
	if msg.DocumentMessage != nil {
		return "document"
	}
	if msg.StickerMessage != nil {
		return "sticker"
	}
	if msg.ReactionMessage != nil {
		return "reaction"
	}
	return "unknown"
}

func (c *Client) saveMediaToDisk(evt *events.Message) *cache.MediaInfo {
	message := evt.Message
	var mediaData whatsmeow.DownloadableMessage
	var mimetype string
	var fileName string

	switch {
	case message.ImageMessage != nil:
		mediaData = message.ImageMessage
		mimetype = message.ImageMessage.Mimetype
		fileName = message.ImageMessage.FileName
	case message.VideoMessage != nil:
		mediaData = message.VideoMessage
		mimetype = message.VideoMessage.Mimetype
		fileName = message.VideoMessage.FileName
	case message.AudioMessage != nil:
		mediaData = message.AudioMessage
		mimetype = message.AudioMessage.Mimetype
		fileName = fmt.Sprintf("audio_%s.ogg", evt.ID)
	case message.DocumentMessage != nil:
		mediaData = message.DocumentMessage
		mimetype = message.DocumentMessage.Mimetype
		fileName = message.DocumentMessage.FileName
	case message.StickerMessage != nil:
		mediaData = message.StickerMessage
		mimetype = "image/webp"
		fileName = fmt.Sprintf("sticker_%s.webp", evt.ID)
	default:
		return &cache.MediaInfo{Error: "Tipo de multimedia no soportado"}
	}

	data, err := c.client.Download(mediaData)
	if err != nil {
		return &cache.MediaInfo{Error: fmt.Sprintf("Error al descargar: %v", err)}
	}

	ext := filepath.Ext(fileName)
	if ext == "" && mimetype != "" {
		parts := strings.Split(mimetype, "/")
		if len(parts) == 2 {
			ext = "." + parts[1]
		}
	}

	randomBytes := make([]byte, 8)
	rand.Read(randomBytes)
	randomID := hex.EncodeToString(randomBytes)

	safeFileName := utils.SanitizeFileName(fileName)
	if safeFileName == "" {
		safeFileName = fmt.Sprintf("media_%s%s", randomID, ext)
	}

	finalFileName := fmt.Sprintf("%d_%s", time.Now().Unix(), safeFileName)
	filePath := filepath.Join(c.tempMediaDir, finalFileName)

	if err := os.WriteFile(filePath, data, 0644); err != nil {
		return &cache.MediaInfo{Error: fmt.Sprintf("Error al guardar: %v", err)}
	}

	return &cache.MediaInfo{
		FilePath:  filePath,
		Mimetype:  mimetype,
		FileName:  finalFileName,
		SizeBytes: int64(len(data)),
	}
}

func (c *Client) cacheSnapshot(snapshot *cache.MessageSnapshot) {
	for _, key := range snapshot.Keys {
		c.messageCache.Set(key, snapshot)
	}
	if snapshot.Key != "" {
		c.messageCache.Set(snapshot.Key, snapshot)
	}
}

func (c *Client) findSnapshotForRevoked(deleteKey types.MessageKey) (*cache.MessageSnapshot, string, []string) {
	lookupKeys := c.buildLookupKeysFromRevoke(deleteKey)

	for _, key := range lookupKeys {
		if snapshot, exists := c.messageCache.Get(key); exists {
			return snapshot, key, lookupKeys
		}
	}

	return nil, "", lookupKeys
}

func (c *Client) buildLookupKeysFromRevoke(deleteKey types.MessageKey) []string {
	keys := []string{}

	remoteJID := deleteKey.RemoteJID.String()
	id := deleteKey.ID
	participant := ""
	if deleteKey.Participant != nil {
		participant = deleteKey.Participant.String()
	}

	canonicalKey := fmt.Sprintf("%s|%s|%s", remoteJID, id, participant)
	keys = append(keys, canonicalKey)

	serializedKey := fmt.Sprintf("false_%s_%s", remoteJID, id)
	if participant != "" {
		serializedKey = fmt.Sprintf("false_%s_%s_%s", remoteJID, id, participant)
	}
	keys = append(keys, serializedKey)

	keys = append(keys, id)
	keys = append(keys, remoteJID+"|"+id)

	return keys
}

func (c *Client) buildMessageKey(evt *events.Message) string {
	keys := c.buildMessageKeys(evt)
	if len(keys) > 0 {
		return keys[0]
	}

	fallback := fmt.Sprintf("%s:%d:%s", evt.Info.Chat.String(), evt.Timestamp.Unix(), evt.ID)
	return fallback
}

func (c *Client) buildMessageKeys(evt *events.Message) []string {
	keys := []string{}

	remoteJID := evt.Info.Chat.String()
	id := evt.ID
	participant := ""
	if evt.Info.Sender.User != "" {
		participant = evt.Info.Sender.String()
	}

	canonicalKey := fmt.Sprintf("%s|%s|%s", remoteJID, id, participant)
	keys = append(keys, canonicalKey)

	fromMe := "false"
	if evt.Info.IsFromMe {
		fromMe = "true"
	}

	serializedKey := fmt.Sprintf("%s_%s_%s", fromMe, remoteJID, id)
	if participant != "" {
		serializedKey = fmt.Sprintf("%s_%s_%s_%s", fromMe, remoteJID, id, participant)
	}
	keys = append(keys, serializedKey)

	keys = append(keys, id)

	return keys
}

func (c *Client) Disconnect() {
	if c.client != nil {
		c.client.Disconnect()
	}
}

func CleanupOldMediaFiles(tempMediaDir string, maxAgeHours int) error {
	entries, err := os.ReadDir(tempMediaDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	now := time.Now()
	maxAge := time.Duration(maxAgeHours) * time.Hour

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		filePath := filepath.Join(tempMediaDir, entry.Name())
		info, err := entry.Info()
		if err != nil {
			continue
		}

		if now.Sub(info.ModTime()) > maxAge {
			os.Remove(filePath)
		}
	}

	return nil
}

func EnsureDir(dirPath string) error {
	return os.MkdirAll(dirPath, 0755)
}
