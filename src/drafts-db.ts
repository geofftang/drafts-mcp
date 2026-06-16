import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { DraftMetadata } from './types.js';

// Drafts stores timestamps as seconds since 2001-01-01 (Apple Cocoa reference date)
const COCOA_EPOCH_OFFSET = 978307200;

interface DraftRow {
  uuid: string;
  title: string | null;
  tags: string | null;
  createdAt: number;
  modifiedAt: number;
  isFlagged: number;
  folder: number;
}

export class DraftsDatabase {
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath =
      dbPath ||
      join(
        homedir(),
        'Library',
        'Group Containers',
        'GTFQ98J4YG.com.agiletortoise.Drafts',
        'DraftStore.sqlite'
      );
  }

  private convertCocoaTimestamp(timestamp: number): string {
    const unixTimestamp = timestamp + COCOA_EPOCH_OFFSET;
    return new Date(unixTimestamp * 1000).toISOString();
  }

  private openDb(): Database.Database {
    try {
      return new Database(this.dbPath, { readonly: true, fileMustExist: true });
    } catch (error) {
      throw new Error(
        `Failed to open Drafts database at ${this.dbPath}: ${error}. ` +
          'Ensure Drafts is installed and the Group Container is accessible.'
      );
    }
  }

  private mapRow(row: DraftRow): DraftMetadata {
    return {
      uuid: row.uuid,
      title: row.title || '',
      tags: row.tags ? row.tags.split(',').filter((t) => t.trim()) : [],
      createdAt: this.convertCocoaTimestamp(row.createdAt),
      modifiedAt: this.convertCocoaTimestamp(row.modifiedAt),
      isFlagged: row.isFlagged === 1,
      isArchived: row.folder === 1,
      isTrashed: row.folder === 2,
    };
  }

  getAllDrafts(options?: {
    folder?: 'inbox' | 'archive' | 'trash' | 'all';
    flagged?: boolean;
  }): DraftMetadata[] {
    const db = this.openDb();
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (options?.folder) {
        switch (options.folder) {
          case 'inbox':
            conditions.push('ZFOLDER = ?');
            params.push(0);
            break;
          case 'archive':
            conditions.push('ZFOLDER = ?');
            params.push(1);
            break;
          case 'trash':
            conditions.push('ZFOLDER = ?');
            params.push(2);
            break;
          // 'all' means no filter
        }
      }

      if (options?.flagged !== undefined) {
        conditions.push('ZFLAGGED = ?');
        params.push(options.flagged ? 1 : 0);
      }

      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

      const query = `
        SELECT
          ZUUID as uuid,
          ZTITLE as title,
          ZCACHED_TAGS as tags,
          ZCREATED_AT as createdAt,
          ZMODIFIED_AT as modifiedAt,
          ZFLAGGED as isFlagged,
          ZFOLDER as folder
        FROM ZMANAGEDDRAFT
        ${whereClause}
        ORDER BY ZMODIFIED_AT DESC
      `;

      const rows = db.prepare(query).all(...params) as DraftRow[];
      return rows.map((row) => this.mapRow(row));
    } catch (error) {
      throw new Error(`Failed to query Drafts database: ${error}`);
    } finally {
      db.close();
    }
  }

  searchDrafts(searchText: string): DraftMetadata[] {
    const db = this.openDb();
    try {
      const term = `%${searchText}%`;

      const query = `
        SELECT
          ZUUID as uuid,
          ZTITLE as title,
          ZCACHED_TAGS as tags,
          ZCREATED_AT as createdAt,
          ZMODIFIED_AT as modifiedAt,
          ZFLAGGED as isFlagged,
          ZFOLDER as folder
        FROM ZMANAGEDDRAFT
        WHERE ZCONTENT LIKE ? OR ZTITLE LIKE ?
        ORDER BY ZMODIFIED_AT DESC
      `;

      const rows = db.prepare(query).all(term, term) as DraftRow[];
      return rows.map((row) => this.mapRow(row));
    } catch (error) {
      throw new Error(`Failed to search drafts: ${error}`);
    } finally {
      db.close();
    }
  }
}
