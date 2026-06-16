import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DraftsDatabase } from '../drafts-db.js';

// Drafts stores timestamps as seconds since 2001-01-01 (Cocoa epoch).
// The converter adds 978307200 to arrive at a Unix timestamp.
const COCOA_EPOCH_OFFSET = 978307200;
function toCocoaTs(isoDate: string): number {
  return Math.floor(new Date(isoDate).getTime() / 1000) - COCOA_EPOCH_OFFSET;
}

function createTestDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ZMANAGEDDRAFT (
      ZUUID TEXT NOT NULL,
      ZTITLE TEXT,
      ZCACHED_TAGS TEXT,
      ZCONTENT TEXT,
      ZCREATED_AT REAL NOT NULL,
      ZMODIFIED_AT REAL NOT NULL,
      ZFLAGGED INTEGER NOT NULL DEFAULT 0,
      ZFOLDER INTEGER NOT NULL DEFAULT 0
    )
  `);

  const insert = db.prepare(`
    INSERT INTO ZMANAGEDDRAFT
      (ZUUID, ZTITLE, ZCACHED_TAGS, ZCONTENT, ZCREATED_AT, ZMODIFIED_AT, ZFLAGGED, ZFOLDER)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    'uuid-inbox-1',
    'Inbox Draft One',
    'work,ideas',
    'Content of inbox draft one',
    toCocoaTs('2024-01-01T10:00:00Z'),
    toCocoaTs('2024-01-10T10:00:00Z'),
    0,
    0 // inbox
  );

  insert.run(
    'uuid-inbox-2',
    "O'Brien's Draft",
    null,
    "Content with O'Brien's quote",
    toCocoaTs('2024-01-02T10:00:00Z'),
    toCocoaTs('2024-01-09T10:00:00Z'),
    0,
    0 // inbox
  );

  insert.run(
    'uuid-archive-1',
    'Archived Draft',
    'archive-tag',
    'Old archived content',
    toCocoaTs('2023-06-01T10:00:00Z'),
    toCocoaTs('2023-06-15T10:00:00Z'),
    0,
    1 // archive
  );

  insert.run(
    'uuid-flagged-1',
    'Flagged Draft',
    null,
    'Important flagged content',
    toCocoaTs('2024-01-05T10:00:00Z'),
    toCocoaTs('2024-01-08T10:00:00Z'),
    1, // flagged
    0 // inbox
  );

  db.close();
}

describe('DraftsDatabase', () => {
  let tmpDir: string;
  let dbPath: string;
  let draftsDb: DraftsDatabase;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'drafts-test-'));
    dbPath = join(tmpDir, 'DraftStore.sqlite');
    createTestDb(dbPath);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    draftsDb = new DraftsDatabase(dbPath);
  });

  describe('getAllDrafts', () => {
    it('returns all drafts when no filter is provided', () => {
      const drafts = draftsDb.getAllDrafts();
      expect(drafts).toHaveLength(4);
    });

    it('maps rows to DraftMetadata correctly', () => {
      const drafts = draftsDb.getAllDrafts({ folder: 'inbox' });
      const draft = drafts.find((d) => d.uuid === 'uuid-inbox-1');
      expect(draft).toBeDefined();
      expect(draft!.title).toBe('Inbox Draft One');
      expect(draft!.tags).toEqual(['work', 'ideas']);
      expect(draft!.isFlagged).toBe(false);
      expect(draft!.isArchived).toBe(false);
      expect(draft!.isTrashed).toBe(false);
      expect(draft!.createdAt).toBe('2024-01-01T10:00:00.000Z');
      expect(draft!.modifiedAt).toBe('2024-01-10T10:00:00.000Z');
    });

    it('filters to inbox only', () => {
      const drafts = draftsDb.getAllDrafts({ folder: 'inbox' });
      // uuid-inbox-1, uuid-inbox-2, uuid-flagged-1 are all ZFOLDER=0
      expect(drafts).toHaveLength(3);
      drafts.forEach((d) => {
        expect(d.isArchived).toBe(false);
        expect(d.isTrashed).toBe(false);
      });
    });

    it('filters to archive only', () => {
      const drafts = draftsDb.getAllDrafts({ folder: 'archive' });
      expect(drafts).toHaveLength(1);
      expect(drafts[0].uuid).toBe('uuid-archive-1');
      expect(drafts[0].isArchived).toBe(true);
    });

    it('filters by flagged=true', () => {
      const drafts = draftsDb.getAllDrafts({ flagged: true });
      expect(drafts).toHaveLength(1);
      expect(drafts[0].uuid).toBe('uuid-flagged-1');
      expect(drafts[0].isFlagged).toBe(true);
    });

    it('filters by flagged=false', () => {
      const drafts = draftsDb.getAllDrafts({ flagged: false });
      expect(drafts).toHaveLength(3);
      drafts.forEach((d) => expect(d.isFlagged).toBe(false));
    });

    it('returns empty array for tags=null', () => {
      const drafts = draftsDb.getAllDrafts({ flagged: true });
      expect(drafts[0].tags).toEqual([]);
    });

    it('orders results by modifiedAt descending', () => {
      const drafts = draftsDb.getAllDrafts();
      const dates = drafts.map((d) => new Date(d.modifiedAt).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
      }
    });
  });

  describe('searchDrafts', () => {
    it('finds drafts matching content', () => {
      const results = draftsDb.searchDrafts('inbox draft');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((d) => d.uuid === 'uuid-inbox-1')).toBe(true);
    });

    it('finds drafts matching title', () => {
      const results = draftsDb.searchDrafts('Archived');
      expect(results).toHaveLength(1);
      expect(results[0].uuid).toBe('uuid-archive-1');
    });

    it('handles SQL injection via single-quote without breaking the query', () => {
      // A naive string-interpolation approach would fail here; bound params handle it safely
      expect(() => {
        const results = draftsDb.searchDrafts("O'Brien");
        expect(Array.isArray(results)).toBe(true);
        expect(results.some((d) => d.uuid === 'uuid-inbox-2')).toBe(true);
      }).not.toThrow();
    });

    it('returns empty array for no matches', () => {
      const results = draftsDb.searchDrafts('zzz-no-match-xyzzy');
      expect(results).toHaveLength(0);
    });

    it('returns DraftMetadata objects with all required fields', () => {
      const results = draftsDb.searchDrafts('inbox');
      expect(results.length).toBeGreaterThan(0);
      const d = results[0];
      expect(typeof d.uuid).toBe('string');
      expect(typeof d.title).toBe('string');
      expect(Array.isArray(d.tags)).toBe(true);
      expect(typeof d.createdAt).toBe('string');
      expect(typeof d.modifiedAt).toBe('string');
      expect(typeof d.isFlagged).toBe('boolean');
      expect(typeof d.isArchived).toBe('boolean');
      expect(typeof d.isTrashed).toBe('boolean');
    });
  });

  describe('error handling', () => {
    it('throws a clear error when db file does not exist', () => {
      const missingDb = new DraftsDatabase('/tmp/does-not-exist/DraftStore.sqlite');
      expect(() => missingDb.getAllDrafts()).toThrow(/Failed to open Drafts database/);
    });
  });
});
