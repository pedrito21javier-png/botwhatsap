package cache

import (
	"sync"
	"time"
)

type MessageSnapshot struct {
	Key                string
	Keys               []string
	Body               string
	Type               string
	TypeLabel          string
	Author             string
	AuthorSource       string
	AuthorPhoneNumber  string
	ContactName        string
	DisplayName        string
	NickName           string
	NameSource         string
	TimestampSeconds   int64
	ChatID             string
	ChatName           string
	OriginType         string
	HasMedia           bool
	MediaInfo          *MediaInfo
	MessageID          string
	SerializedMessageID string
	FromMe             bool
	CreatedAtMs        int64
}

type MediaInfo struct {
	FilePath  string
	Mimetype  string
	FileName  string
	SizeBytes int64
	Error     string
}

type ReportRecord struct {
	ID            string
	Snapshot      *MessageSnapshot
	DeletedAtMs   int64
	CacheHit      bool
	MatchedKey    string
	LookupKeys    []string
	CreatedAtMs   int64
}

type MessageCache struct {
	mu       sync.RWMutex
	cache    map[string]*MessageSnapshot
	maxSize  int
	retention time.Duration
}

type ReportStore struct {
	mu        sync.RWMutex
	store     map[string]*ReportRecord
	maxSize   int
	retention time.Duration
}

func NewMessageCache(maxSize int, retentionHours int) *MessageCache {
	return &MessageCache{
		cache:     make(map[string]*MessageSnapshot),
		maxSize:   maxSize,
		retention: time.Duration(retentionHours) * time.Hour,
	}
}

func NewReportStore(maxSize int, retentionHours int) *ReportStore {
	return &ReportStore{
		store:     make(map[string]*ReportRecord),
		maxSize:   maxSize,
		retention: time.Duration(retentionHours) * time.Hour,
	}
}

func (mc *MessageCache) Set(key string, snapshot *MessageSnapshot) {
	mc.mu.Lock()
	defer mc.mu.Unlock()

	mc.cache[key] = snapshot

	for len(mc.cache) > mc.maxSize {
		for k := range mc.cache {
			delete(mc.cache, k)
			break
		}
	}
}

func (mc *MessageCache) Get(key string) (*MessageSnapshot, bool) {
	mc.mu.RLock()
	defer mc.mu.RUnlock()

	snapshot, exists := mc.cache[key]
	if !exists {
		return nil, false
	}

	if time.Since(time.UnixMilli(snapshot.CreatedAtMs)) > mc.retention {
		return nil, false
	}

	return snapshot, true
}

func (mc *MessageCache) Cleanup() {
	mc.mu.Lock()
	defer mc.mu.Unlock()

	now := time.Now()
	for key, snapshot := range mc.cache {
		if now.Sub(time.UnixMilli(snapshot.CreatedAtMs)) > mc.retention {
			delete(mc.cache, key)
		}
	}
}

func (rs *ReportStore) Add(record *ReportRecord) {
	rs.mu.Lock()
	defer rs.mu.Unlock()

	rs.store[record.ID] = record

	for len(rs.store) > rs.maxSize {
		for k := range rs.store {
			delete(rs.store, k)
			break
		}
	}
}

func (rs *ReportStore) Get(id string) (*ReportRecord, bool) {
	rs.mu.RLock()
	defer rs.mu.RUnlock()

	record, exists := rs.store[id]
	if !exists {
		return nil, false
	}

	if time.Since(time.UnixMilli(record.CreatedAtMs)) > rs.retention {
		delete(rs.store, id)
		return nil, false
	}

	return record, true
}

func (rs *ReportStore) Cleanup() {
	rs.mu.Lock()
	defer rs.mu.Unlock()

	now := time.Now()
	for id, record := range rs.store {
		if now.Sub(time.UnixMilli(record.CreatedAtMs)) > rs.retention {
			delete(rs.store, id)
		}
	}
}
