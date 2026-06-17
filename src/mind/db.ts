import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Abre (y prepara) la base de datos de Samara. Una sola conexión se comparte
 * entre la memoria de largo plazo y las relaciones, así todo su "estado"
 * persistente vive en un mismo archivo.
 */
export function openDb(path = 'data/samara.db'): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  sqliteVec.load(db); // habilita las tablas vectoriales (memoria)
  db.pragma('journal_mode = WAL');
  return db;
}

export type DB = Database.Database;
