package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"github.com/user/whatsapp-delete-alert-bot/internal/cache"
	"github.com/user/whatsapp-delete-alert-bot/internal/config"
	"github.com/user/whatsapp-delete-alert-bot/internal/telegram"
	"github.com/user/whatsapp-delete-alert-bot/internal/whatsapp"
)

func main() {
	if err := godotenv.Load(); err != nil {
		log.Println("No se encontró archivo .env, usando variables de entorno del sistema")
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Error al cargar configuración: %v", err)
	}

	log.Println("Preparando directorios temporales y sesión persistente...")

	if err := whatsapp.EnsureDir(cfg.TempMediaDir); err != nil {
		log.Fatalf("Error al crear directorio temporal: %v", err)
	}

	messageCache := cache.NewMessageCache(cfg.MessageCacheMaxEntries, cfg.MessageCacheRetentionHours)
	reportStore := cache.NewReportStore(cfg.ReportStoreMaxEntries, cfg.ReportStoreRetentionHours)

	telegramBot, err := telegram.NewBot(cfg.TelegramBotToken, cfg.TelegramChatID, reportStore)
	if err != nil {
		log.Fatalf("Error al crear el bot de Telegram: %v", err)
	}

	whatsAppClient := whatsapp.NewClient(messageCache, reportStore, cfg.TempMediaDir, telegramBot)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	telegramBot.SetupHandlers()
	telegramBot.Start(ctx)

	go func() {
		ticker := time.NewTicker(time.Duration(cfg.CleanupIntervalMinutes) * time.Minute)
		defer ticker.Stop()

		for range ticker.C {
			if err := whatsapp.CleanupOldMediaFiles(cfg.TempMediaDir, cfg.MediaMaxAgeHours); err != nil {
				log.Printf("Error durante la limpieza de archivos temporales: %v", err)
			}
			messageCache.Cleanup()
			reportStore.Cleanup()
		}
	}()

	go func() {
		ticker := time.NewTicker(30 * time.Minute)
		defer ticker.Stop()

		for range ticker.C {
			messageCache.Cleanup()
			reportStore.Cleanup()
		}
	}()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigChan
		log.Println("Recibida señal de cierre, cerrando...")
		cancel()
		telegramBot.Stop(ctx)
		whatsAppClient.Disconnect()
		os.Exit(0)
	}()

	log.Printf("Iniciando WhatsApp Web. Sesión persistente: %s", cfg.WWebJSAuthDir)
	log.Println("Si es el primer inicio, aparecerá un QR para escanear.")

	if err := whatsAppClient.Connect(ctx); err != nil {
		log.Fatalf("Error fatal al iniciar el bot: %v", err)
	}

	select {
	case <-ctx.Done():
		log.Println("Contexto cancelado, cerrando...")
	}
}
