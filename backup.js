/**
 * MemCore Database Backup Script
 * Copies the current db.sqlite file to a timestamped backup file in backups/
 */

const fs = require('fs');
const path = require('path');

const DB_DIR = __dirname;
const DB_PATH = path.join(DB_DIR, 'db.sqlite');
const BACKUPS_DIR = path.join(DB_DIR, 'backups');

function runBackup() {
  console.log('--- Starting MemCore Backup ---');

  if (!fs.existsSync(DB_PATH)) {
    console.error(`Error: Source database file not found at: ${DB_PATH}`);
    process.exit(1);
  }

  // Create backups directory if it doesn't exist
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    console.log(`Created backups directory: ${BACKUPS_DIR}`);
  }

  // Generate timestamped filename
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  const secs = String(now.getSeconds()).padStart(2, '0');

  const timestamp = `${year}-${month}-${date}_${hours}-${mins}-${secs}`;
  const backupFileName = `db-backup-${timestamp}.sqlite`;
  const backupPath = path.join(BACKUPS_DIR, backupFileName);

  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    
    // Escaped backup path for safe insertion into raw SQL string
    const escapedBackupPath = backupPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escapedBackupPath}';`);
    
    console.log(`Successfully backed up database (atomic VACUUM INTO) to: ${backupPath}`);
    console.log('Backup complete ✓');
  } catch (err) {
    console.error(`Backup failed: ${err.message}`);
    process.exit(1);
  }
}

runBackup();
