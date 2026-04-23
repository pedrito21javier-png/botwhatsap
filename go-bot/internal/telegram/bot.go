package telegram

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
	"github.com/user/whatsapp-delete-alert-bot/internal/cache"
	"github.com/user/whatsapp-delete-alert-bot/pkg/utils"
)

const (
	TelegramMessageLimit = 4096
	TelegramCaptionLimit = 1024
)

type Bot struct {
	client      *bot.Bot
	chatID      string
	reportStore *cache.ReportStore
}

type ReportDetails struct {
	AuthorName     string
	AuthorPhone    string
	AuthorWid      string
	CacheKey       string
	ChatID         string
	ContactName    string
	Content        string
	DeletedAtClock string
	DeletedAtText  string
	ElapsedText    string
	LocationDetails string
	MediaStatus    string
	NickName       string
	OriginType     string
	SentAtClock    string
	SentAtText     string
	TypeLabel      string
	WaUrl          string
}

func NewBot(token, chatID string, reportStore *cache.ReportStore) (*Bot, error) {
	b, err := bot.New(token)
	if err != nil {
		return nil, fmt.Errorf("error al crear el bot de Telegram: %w", err)
	}

	return &Bot{
		client:      b,
		chatID:      chatID,
		reportStore: reportStore,
	}, nil
}

func (b *Bot) Start(ctx context.Context) {
	go func() {
		if err := b.client.Start(ctx); err != nil {
			log.Printf("Error al iniciar el polling de Telegram: %v", err)
		}
	}()
	log.Println("Bot de Telegram listo para botones inline.")
}

func (b *Bot) Stop(ctx context.Context) {
	b.client.Stop()
}

func (b *Bot) SetupHandlers() {
	b.client.RegisterHandler(bot.HandlerTypeCallbackQuery, "deltech:", false, b.handleTechnicalData)
}

func (b *Bot) handleTechnicalData(ctx context.Context, bi bot.BotInterface, update *models.Update) {
	if update.CallbackQuery == nil {
		return
	}

	callbackData := update.CallbackQuery.Data
	if !strings.HasPrefix(callbackData, "deltech:") {
		return
	}

	recordID := strings.TrimPrefix(callbackData, "deltech:")
	record, exists := b.reportStore.Get(recordID)

	if !exists {
		b.client.AnswerCallbackQuery(ctx, &bot.AnswerCallbackQueryParams{
			CallbackQueryID: update.CallbackQuery.ID,
			Text:            "Reporte no disponible",
			ShowAlert:       true,
		})
		return
	}

	b.client.AnswerCallbackQuery(ctx, &bot.AnswerCallbackQueryParams{
		CallbackQueryID: update.CallbackQuery.ID,
		Text:            "Datos tecnicos enviados",
	})

	technicalReport := b.buildTechnicalReport(record)
	b.client.SendMessage(ctx, &bot.SendMessageParams{
		ChatID:    update.CallbackQuery.Message.Chat.ID,
		Text:      technicalReport,
		ParseMode: models.ParseModeHTML,
	})
}

func (b *Bot) buildTechnicalReport(record *cache.ReportRecord) string {
	snapshot := record.Snapshot
	details := buildReportDetails(snapshot, record.DeletedAtMs)

	lines := []string{
		"<b>Datos tecnicos</b>",
		"",
		fmt.Sprintf("WhatsApp ID: <code>%s</code>", utils.EscapeHTML(details.AuthorWid)),
		fmt.Sprintf("Chat ID: <code>%s</code>", utils.EscapeHTML(details.ChatID)),
		fmt.Sprintf("Message ID: <code>%s</code>", utils.EscapeHTML(utils.FirstNonEmpty(snapshot.MessageID, "No disponible"))),
		fmt.Sprintf("Fuente autor: <code>%s</code>", utils.EscapeHTML(utils.FirstNonEmpty(snapshot.AuthorSource, "No disponible"))),
		fmt.Sprintf("Cache key: <code>%s</code>", utils.EscapeHTML(utils.TruncateText(utils.FirstNonEmpty(record.MatchedKey, details.CacheKey), 160))),
		fmt.Sprintf("Media status: <code>%s</code>", utils.EscapeHTML(details.MediaStatus)),
	}

	return strings.Join(lines, "\n")
}

func (b *Bot) SendReport(snapshot *cache.MessageSnapshot, lookupKeys []string, matchedKey string) error {
	deletedAtMs := time.Now().UnixMilli()

	record := &cache.ReportRecord{
		ID:         generateID(),
		Snapshot:   snapshot,
		DeletedAtMs: deletedAtMs,
		CacheHit:   snapshot != nil,
		MatchedKey: matchedKey,
		LookupKeys: lookupKeys,
		CreatedAtMs: time.Now().UnixMilli(),
	}

	b.reportStore.Add(record)

	return b.sendStoredReport(record)
}

func (b *Bot) sendStoredReport(record *cache.ReportRecord) error {
	snapshot := record.Snapshot

	hasCapturedMedia := snapshot.HasMedia &&
		snapshot.MediaInfo != nil &&
		snapshot.MediaInfo.FilePath != "" &&
		snapshot.MediaInfo.Error == "" &&
		fileExists(snapshot.MediaInfo.FilePath)

	keyboard := b.buildReportKeyboard(record)

	mainReport := buildMainReport(snapshot, record.DeletedAtMs, TelegramMessageLimit)

	if !hasCapturedMedia {
		_, err := b.client.SendMessage(context.Background(), &bot.SendMessageParams{
			ChatID:      b.chatID,
			Text:        mainReport,
			ParseMode:   models.ParseModeHTML,
			ReplyMarkup: keyboard,
		})
		return err
	}

	mediaFile, err := os.Open(snapshot.MediaInfo.FilePath)
	if err != nil {
		return fmt.Errorf("error al abrir archivo multimedia: %w", err)
	}
	defer mediaFile.Close()

	caption := buildMainReport(snapshot, record.DeletedAtMs, TelegramCaptionLimit)

	mimetype := snapshot.MediaInfo.Mimetype
	fileName := snapshot.MediaInfo.FileName

	var input io.Reader = mediaFile

	if strings.HasPrefix(mimetype, "image/") {
		_, err = b.client.SendPhoto(context.Background(), &bot.SendPhotoParams{
			ChatID:  b.chatID,
			Photo:   &models.InputFileUpload{Filename: fileName, Data: readAll(input)},
			Caption: caption,
			ParseMode: models.ParseModeHTML,
			ReplyMarkup: keyboard,
		})
	} else if strings.HasPrefix(mimetype, "video/") {
		_, err = b.client.SendVideo(context.Background(), &bot.SendVideoParams{
			ChatID:  b.chatID,
			Video:   &models.InputFileUpload{Filename: fileName, Data: readAll(input)},
			Caption: caption,
			ParseMode: models.ParseModeHTML,
			ReplyMarkup: keyboard,
		})
	} else if strings.HasPrefix(mimetype, "audio/") {
		_, err = b.client.SendAudio(context.Background(), &bot.SendAudioParams{
			ChatID:  b.chatID,
			Audio:   &models.InputFileUpload{Filename: fileName, Data: readAll(input)},
			Caption: caption,
			ParseMode: models.ParseModeHTML,
			ReplyMarkup: keyboard,
		})
	} else {
		_, err = b.client.SendDocument(context.Background(), &bot.SendDocumentParams{
			ChatID:    b.chatID,
			Document:  &models.InputFileUpload{Filename: fileName, Data: readAll(input)},
			Caption:   caption,
			ParseMode: models.ParseModeHTML,
			ReplyMarkup: keyboard,
		})
	}

	return err
}

func readAll(r io.Reader) []byte {
	data, _ := io.ReadAll(r)
	return data
}

func (b *Bot) buildReportKeyboard(record *cache.ReportRecord) *models.InlineKeyboardMarkup {
	snapshot := record.Snapshot
	waUrl := utils.BuildWhatsAppChatUrl(snapshot.AuthorPhoneNumber)

	buttons := []models.InlineKeyboardButton{}

	if waUrl != "" {
		buttons = append(buttons, models.InlineKeyboardButton{
			Text: "Abrir WhatsApp",
			URL:  waUrl,
		})
	}

	buttons = append(buttons, models.InlineKeyboardButton{
		Text:         "Datos tecnicos",
		CallbackData: "deltech:" + record.ID,
	})

	return &models.InlineKeyboardMarkup{
		InlineKeyboard: [][]models.InlineKeyboardButton{buttons},
	}
}

func buildReportDetails(snapshot *cache.MessageSnapshot, deletedAtMs int64) *ReportDetails {
	sentAtMs := snapshot.TimestampSeconds * 1000
	elapsedMs := deletedAtMs - sentAtMs

	content := snapshot.Body
	if content == "[Sin texto]" {
		content = "Sin texto visible"
	}

	authorName := utils.FirstNonEmpty(snapshot.ContactName, snapshot.NickName, snapshot.AuthorPhoneNumber, "Desconocido")

	return &ReportDetails{
		AuthorName:      authorName,
		AuthorPhone:     utils.FirstNonEmpty(snapshot.AuthorPhoneNumber, "Desconocido"),
		AuthorWid:       utils.FirstNonEmpty(snapshot.Author, "No disponible"),
		CacheKey:        utils.FirstNonEmpty(snapshot.Key, "No disponible"),
		ChatID:          utils.FirstNonEmpty(snapshot.ChatID, "No disponible"),
		ContactName:     utils.FirstNonEmpty(snapshot.ContactName, "No guardado"),
		Content:         content,
		DeletedAtClock:  utils.FormatClockFromMs(deletedAtMs),
		DeletedAtText:   time.UnixMilli(deletedAtMs).Format("02/01/2006 15:04:05"),
		ElapsedText:     utils.FormatElapsed(elapsedMs),
		LocationDetails: utils.GetLocationDetails(snapshot.OriginType, snapshot.ChatName),
		MediaStatus:     utils.GetMediaStatus(snapshot.HasMedia, &utils.MediaInfoWrapper{
			FilePath: snapshot.MediaInfo.FilePath,
			FileName: snapshot.MediaInfo.FileName,
			Error:    snapshot.MediaInfo.Error,
		}),
		NickName:       utils.FirstNonEmpty(snapshot.NickName, "No disponible"),
		OriginType:     utils.FirstNonEmpty(snapshot.OriginType, "Desconocido"),
		SentAtClock:    utils.FormatClockFromMs(sentAtMs),
		SentAtText:     utils.FormatTimestamp(snapshot.TimestampSeconds),
		TypeLabel:      utils.FormatMessageType(snapshot.Type),
		WaUrl:          utils.BuildWhatsAppChatUrl(snapshot.AuthorPhoneNumber),
	}
}

func buildMainReport(snapshot *cache.MessageSnapshot, deletedAtMs int64, maxLength int) string {
	details := buildReportDetails(snapshot, deletedAtMs)

	baseLines := []string{
		"🗑️ <b>MENSAJE ELIMINADO</b>",
		"",
		fmt.Sprintf("👤 Nombre: <b>%s</b>", utils.EscapeHTML(utils.TruncateText(details.AuthorName, 80))),
		fmt.Sprintf("🏷️ Nick: <b>%s</b>", utils.EscapeHTML(utils.TruncateText(details.NickName, 80))),
		fmt.Sprintf("📱 Numero: <code>%s</code>", utils.EscapeHTML(utils.TruncateText(details.AuthorPhone, 40))),
		"",
		fmt.Sprintf("💬 Chat: <b>%s</b>", utils.EscapeHTML(utils.TruncateText(details.LocationDetails, 120))),
		fmt.Sprintf("📦 Tipo: <b>%s</b>", utils.EscapeHTML(utils.TruncateText(details.TypeLabel, 40))),
		fmt.Sprintf("⏳ Duracion: <b>%s</b>", utils.EscapeHTML(details.ElapsedText)),
		fmt.Sprintf("🕒 Hora: <b>%s</b> → <b>%s</b>", utils.EscapeHTML(details.SentAtClock), utils.EscapeHTML(details.DeletedAtClock)),
		"",
		"📝 <b>Contenido</b>",
	}

	baseText := strings.Join(baseLines, "\n")
	remaining := maxLength - len(baseText) - 1

	content := details.Content
	if len(content) > remaining {
		if remaining > 3 {
			content = content[:remaining-3] + "..."
		} else {
			content = ""
		}
	}

	return baseText + "\n" + utils.EscapeHTML(content)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func generateID() string {
	return fmt.Sprintf("%x", time.Now().UnixNano())
}
