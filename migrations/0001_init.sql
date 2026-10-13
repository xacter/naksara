-- Naksara bulut veritabanı şeması
-- docs: her belgenin (finance, stock) güncel sürüm numarası
CREATE TABLE IF NOT EXISTS docs (
  key        TEXT PRIMARY KEY,
  rev        INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  chunks     INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device     TEXT
);

-- Sürüm numarası yalnızca birer birer artabilir: aynı anda iki cihaz kaydederse
-- ikincisinin yazması tümüyle geri alınır (iyimser kilit / compare-and-swap).
CREATE TRIGGER IF NOT EXISTS docs_cas_update BEFORE UPDATE OF rev ON docs
WHEN NEW.rev <> OLD.rev + 1
BEGIN SELECT RAISE(ABORT, 'NK_CONFLICT'); END;


-- chunks: belge içeriği (büyük belgeler parçalara bölünür; D1 satır sınırı 2 MB)
CREATE TABLE IF NOT EXISTS chunks (
  key  TEXT NOT NULL,
  rev  INTEGER NOT NULL,
  idx  INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (key, rev, idx)
) WITHOUT ROWID;

-- versions: sürüm geçmişi (yedek / geri dönüş). keep=1 → günlük anlık görüntü
CREATE TABLE IF NOT EXISTS versions (
  key        TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  device     TEXT,
  kind       TEXT NOT NULL DEFAULT 'save',
  keep       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, rev)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS versions_by_time ON versions (key, created_at);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_fail (
  ip    TEXT PRIMARY KEY,
  n     INTEGER NOT NULL,
  until INTEGER NOT NULL,
  last  INTEGER NOT NULL
);
