/*****************
 * CONFIG
 *****************/
const CONFIG = {
  DRIVE_ROOT_FOLDER_ID: "1ENI41jtXLOsnV8Gi3r2osp8h5N9Q9ZxH", // Carpeta raiz
  PHOTOS_FOLDER_ID: "1zYwHqbfUWN70ZvpRZyTjmX8n3AgHwKTS",     // Carpeta específica para fotos
  TEMPLATE_SHEET_ID: "1A-HW6AxcZtrRZ5p7SzrOv4CmyeyPbGbl3g4OerhFZtU", // Google sheet template
  SHEET_NAME: "Daily Log",

  HEADER: {
    DATE: "B3",
    DRIVER: "D3",
    ROUTE_TIME: "H3"
  },

  COLS: {
    NUMBER: 1,
    DATE: 2,
    SENDER: 3,
    DESCRIPTION: 4,
    QTY: 5,
    RECEIVER: 6,
    LOCATION: 7,
    SIGNATURE: 8,
    NOTES: 9,
    PHOTO1: 10,
    PHOTO2: 11,
    PHOTO3: 12,
    PHOTO4: 13,
    PHOTO5: 14
  },

  TOKEN_PREFIX: "SIGN_",
  TOKEN_TTL_DAYS: 7
};

// Photos
const PHOTO_NOTE_PREFIX = "PHOTOID:";
const PHOTO_THUMB_NOTE_PREFIX = "PHOTOTHUMB:"; // ✅ NUEVO (thumbnail base64)
const PHOTO_MAX_SLOTS = 5;

// LÍMITES (los que tiran tu error)
const MAX_IMAGE_SIZE_MB = 2;
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;
const MAX_IMAGE_PIXELS = 1000000;     // 1 millón
const MAX_IMAGE_MAX_SIDE = 1000;      // seguridad extra

// Priority highlighting
const PRIORITY_HIGH_ROW_COLOR = "#f6b26b";

/*****************
 * IMG SAFETY (real resize using ImagesService)
 * - Esto SÍ reduce pixeles y tamaño real cuando haga falta
 *****************/
function compressImageIfNeeded_(blob, filename) {
  const originalBytes = blob.getBytes().length;

  // Si ya es pequeño, intentamos igual validar pixeles (por si viene enorme pero comprimido raro)
  let img;
  try {
    img = ImagesService.openImage(blob);
  } catch (e) {
    // Si no se puede abrir como imagen, devolvemos tal cual (pero insertImage podría fallar)
    return { blob: blob.setName(filename), compressed: false };
  }

  let w = (typeof img.getWidth === "function") ? img.getWidth() : null;
  let h = (typeof img.getHeight === "function") ? img.getHeight() : null;

  let outBlob = blob;
  let compressed = false;

  for (let attempt = 0; attempt < 6; attempt++) {
    const bytes = outBlob.getBytes().length;
    let needs = false;

    if (bytes > MAX_IMAGE_SIZE_BYTES) needs = true;
    if (w && h && (w * h) > MAX_IMAGE_PIXELS) needs = true;
    if (w && h && Math.max(w, h) > MAX_IMAGE_MAX_SIDE) needs = true;

    if (!needs) break;

    // Calcular escala para cumplir pixeles + maxSide
    let scale = 1;
    if (w && h) {
      const bySide = MAX_IMAGE_MAX_SIDE / Math.max(w, h);
      const byPix = Math.sqrt(MAX_IMAGE_PIXELS / (w * h));
      scale = Math.min(1, bySide, byPix);

      // Si además está grande en bytes, achicamos un poquito más
      if (bytes > MAX_IMAGE_SIZE_BYTES) scale = Math.min(scale, 0.85);

      const nw = Math.max(1, Math.round(w * scale));
      const nh = Math.max(1, Math.round(h * scale));

      const resized = ImagesService.openImage(outBlob).resize(nw, nh);
      outBlob = resized.getBlob().setName(filename);
      w = nw; h = nh;
      compressed = true;
      continue;
    }

    // Si no tenemos dimensiones, último recurso: resize “genérico”
    const resized2 = ImagesService.openImage(outBlob).resize(900, 900);
    outBlob = resized2.getBlob().setName(filename);
    compressed = true;
  }

  const finalBytes = outBlob.getBytes().length;
  if (finalBytes > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(
      `No se pudo reducir la imagen por debajo de 2MB. Tamaño final: ${(finalBytes / 1024 / 1024).toFixed(2)} MB. ` +
      `Toma/elige una foto más pequeña.`
    );
  }

  // Log útil
  console.log(`IMG bytes: ${(originalBytes/1024/1024).toFixed(2)}MB -> ${(finalBytes/1024/1024).toFixed(2)}MB`);
  return { blob: outBlob, compressed };
}

/*****************
 * Helpers: note parsing
 *****************/
function parseFromNoteLine_(note, prefix) {
  const lines = String(note || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "").trim();
    if (line.indexOf(prefix) === 0) return line.substring(prefix.length).trim();
  }
  // También soporta el caso viejo (startsWith)
  const s = String(note || "").trim();
  if (s.startsWith(prefix)) return s.substring(prefix.length).trim();
  return "";
}

function parsePhotoIdFromNote_(note) {
  return parseFromNoteLine_(note, PHOTO_NOTE_PREFIX);
}

function parsePhotoThumbFromNote_(note) {
  return parseFromNoteLine_(note, PHOTO_THUMB_NOTE_PREFIX);
}

function buildDriveViewUrl_(fileId) {
  return "https://drive.google.com/uc?export=view&id=" + encodeURIComponent(String(fileId || "").trim());
}

function extractIdFromUrl_(s) {
  const str = String(s || "");
  let m = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m && m[1]) return m[1];
  m = str.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m && m[1]) return m[1];
  return "";
}

function extractIdFromImageFormula_(formula) {
  const f = String(formula || "");
  return extractIdFromUrl_(f);
}

/*****************
 * Base64 fallback (ONLY if no thumb exists)
 *****************/
function getPhotoAsBase64_(fileId) {
  try {
    if (!fileId) return null;
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const bytes = blob.getBytes();

    // Seguridad: si por alguna razón sigue enorme, no devolvemos base64 completo
    if (bytes.length > 950 * 1024) { // ~0.93MB
      return null;
    }

    const base64 = Utilities.base64Encode(bytes);
    const mimeType = blob.getContentType() || "image/jpeg";
    return {
      base64: `data:${mimeType};base64,${base64}`,
      mimeType: mimeType,
      fileName: file.getName(),
      fileId: fileId
    };
  } catch (e) {
    console.log("Error getting photo as Base64:", e.message);
    return null;
  }
}

function getPhotoFullBase64(payload) {
  try {
    payload = payload || {};
    const fileId = String(payload.fileId || "").trim();
    if (!fileId) throw new Error("fileId is required.");

    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const bytes = blob.getBytes();
    const base64 = Utilities.base64Encode(bytes);
    const mimeType = blob.getContentType() || "image/jpeg";

    return {
      success: true,
      base64: `data:${mimeType};base64,${base64}`,
      mimeType,
      fileName: file.getName(),
      fileId
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/*****************
 * Get photo slots (reads PHOTOID + PHOTOTHUMB from notes)
 *****************/
function getPhotoSlotsForRow_(sheet, rowNumber) {
  const startCol = CONFIG.COLS.PHOTO1;
  const range = sheet.getRange(rowNumber, startCol, 1, PHOTO_MAX_SLOTS);
  const notes = range.getNotes()[0];
  const formulas = range.getFormulas()[0];
  const values = range.getDisplayValues()[0];

  const out = [];
  for (let i = 0; i < PHOTO_MAX_SLOTS; i++) {
    const note = notes[i] || "";
    let id = parsePhotoIdFromNote_(note);
    if (!id) id = extractIdFromImageFormula_(formulas[i]);
    if (!id) id = extractIdFromUrl_(values[i]);

    if (id) {
      const thumb = parsePhotoThumbFromNote_(note);
      let base64 = thumb || null;

      if (!base64) {
        const b = getPhotoAsBase64_(id);
        base64 = b ? b.base64 : null;
      }

      out.push({
        slot: i + 1,
        id: id,
        url: buildDriveViewUrl_(id),
        base64: base64,
        hasBase64: !!base64
      });
    }
  }
  return out;
}

function getPhotoSlotsFromRowNotes_(rowNotes) {
  const out = [];
  if (!rowNotes || !rowNotes.length) return out;

  const cols = [CONFIG.COLS.PHOTO1, CONFIG.COLS.PHOTO2, CONFIG.COLS.PHOTO3, CONFIG.COLS.PHOTO4, CONFIG.COLS.PHOTO5];

  for (let i = 0; i < cols.length; i++) {
    const idx = cols[i] - 1;
    const note = rowNotes[idx] || "";
    const id = parsePhotoIdFromNote_(note);
    if (id) {
      const thumb = parsePhotoThumbFromNote_(note);
      let base64 = thumb || null;

      if (!base64) {
        const b = getPhotoAsBase64_(id);
        base64 = b ? b.base64 : null;
      }

      out.push({
        slot: i + 1,
        id: id,
        url: buildDriveViewUrl_(id),
        base64: base64,
        hasBase64: !!base64
      });
    }
  }
  return out;
}

function ensurePhotoColumnsFormatting_(sheet) {
  try {
    sheet.setColumnWidth(CONFIG.COLS.PHOTO1, 120);
    sheet.setColumnWidth(CONFIG.COLS.PHOTO2, 120);
    sheet.setColumnWidth(CONFIG.COLS.PHOTO3, 120);
    sheet.setColumnWidth(CONFIG.COLS.PHOTO4, 120);
    sheet.setColumnWidth(CONFIG.COLS.PHOTO5, 120);
  } catch (e) {}
}

/*****************
 * WEB APP
 *****************/
function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const token = params.token ? String(params.token) : "";
  const page = params.page ? String(params.page).toLowerCase() : "";

  if (token) {
    const t = HtmlService.createTemplateFromFile("Signature");
    t.token = token;
    return t.evaluate()
      .setTitle("Sign Package")
      .addMetaTag("viewport", "width=device-width, initial-scale=1");
  }

  if (page === "camera") {
    const t = HtmlService.createTemplateFromFile("Camera");
    t.fileId = params.fileId ? String(params.fileId) : "";
    t.rowNumber = params.rowNumber ? String(params.rowNumber) : "";
    return t.evaluate()
      .setTitle("Package Photos")
      .addMetaTag("viewport", "width=device-width, initial-scale=1");
  }

  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("Package Log")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/*****************
 * DRIVE: List folders + files (Sheets)
 *****************/
function listFolder(payload) {
  try {
    payload = payload || {};
    const requestedId = (payload.folderId && String(payload.folderId).trim())
      ? String(payload.folderId).trim()
      : CONFIG.DRIVE_ROOT_FOLDER_ID;

    if (!isFolderUnderRoot_(requestedId, CONFIG.DRIVE_ROOT_FOLDER_ID)) {
      throw new Error("Folder is outside the allowed ROOT.");
    }

    const folder = DriveApp.getFolderById(requestedId);

    let parentId = null;
    const parents = folder.getParents();
    if (parents.hasNext()) parentId = parents.next().getId();
    if (requestedId === CONFIG.DRIVE_ROOT_FOLDER_ID) parentId = null;

    const subfolders = [];
    const foldersIt = folder.getFolders();
    while (foldersIt.hasNext()) {
      const f = foldersIt.next();
      subfolders.push({ id: f.getId(), name: f.getName(), type: "folder" });
    }
    subfolders.sort((a, b) => a.name.localeCompare(b.name));

    const files = [];
    const filesIt = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
    while (filesIt.hasNext()) {
      const f = filesIt.next();
      files.push({
        id: f.getId(),
        name: f.getName(),
        url: f.getUrl(),
        lastModified: f.getLastUpdated().toISOString(),
        type: "spreadsheet"
      });
    }
    files.sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));

    return {
      success: true,
      rootFolderId: CONFIG.DRIVE_ROOT_FOLDER_ID,
      folderId: requestedId,
      folderName: folder.getName(),
      parentId,
      subfolders,
      files
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function isFolderUnderRoot_(folderId, rootId) {
  if (folderId === rootId) return true;

  let current = DriveApp.getFolderById(folderId);
  const visited = {};
  for (let i = 0; i < 60; i++) {
    const parents = current.getParents();
    if (!parents.hasNext()) return false;

    const p = parents.next();
    const pid = p.getId();
    if (pid === rootId) return true;

    if (visited[pid]) return false;
    visited[pid] = true;

    current = p;
  }
  return false;
}

/*****************
 * CREATE NEW FILE from template
 *****************/
function createNewFile(payload) {
  try {
    payload = payload || {};
    const routeDate = String(payload.routeDate || "").trim();
    const driver = String(payload.driver || "").trim();
    const routeTime = String(payload.routeTime || "").trim();
    const folderId = (payload.folderId && String(payload.folderId).trim())
      ? String(payload.folderId).trim()
      : CONFIG.DRIVE_ROOT_FOLDER_ID;

    if (!isFolderUnderRoot_(folderId, CONFIG.DRIVE_ROOT_FOLDER_ID)) {
      throw new Error("Target folder is outside the allowed ROOT.");
    }
    if (!routeDate || !driver || !routeTime) {
      throw new Error("Missing: routeDate, driver, routeTime.");
    }

    const folder = DriveApp.getFolderById(folderId);
    const template = DriveApp.getFileById(CONFIG.TEMPLATE_SHEET_ID);

    const nameDate = formatDateForFileName_(routeDate);
    const nameTime = (routeTime.toUpperCase() === "2PM") ? "2pm" : "10am";
    const fileName = `Package_Transport_Log_${nameDate}-${nameTime}`;

    const newFile = template.makeCopy(fileName, folder);
    const fileId = newFile.getId();

    const ss = SpreadsheetApp.openById(fileId);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getSheets()[0];

    sheet.getRange(CONFIG.HEADER.DATE).setValue(routeDate);
    sheet.getRange(CONFIG.HEADER.DRIVER).setValue(driver);
    sheet.getRange(CONFIG.HEADER.ROUTE_TIME).setValue(routeTime);

    return {
      success: true,
      fileId,
      fileName,
      url: `https://docs.google.com/spreadsheets/d/${fileId}/edit`
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function formatDateForFileName_(routeDate) {
  const s = String(routeDate).trim();

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const yy = iso[1].slice(2);
    return `${iso[2]}-${iso[3]}-${yy}`;
  }

  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (mdy) {
    const mm = mdy[1].padStart(2, "0");
    const dd = mdy[2].padStart(2, "0");
    const yy = (mdy[3].length === 4) ? mdy[3].slice(2) : mdy[3];
    return `${mm}-${dd}-${yy}`;
  }

  return s.replace(/[\/\\:*?"<>|]/g, "-").slice(0, 30);
}

/*****************
 * READ FILE DATA
 *****************/
function getFileData(payload) {
  try {
    payload = payload || {};
    const fileId = String(payload.fileId || "").trim();
    if (!fileId) throw new Error("fileId is required.");

    const ss = SpreadsheetApp.openById(fileId);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getSheets()[0];

    const header = {
      date: sheet.getRange(CONFIG.HEADER.DATE).getDisplayValue(),
      driver: sheet.getRange(CONFIG.HEADER.DRIVER).getDisplayValue(),
      routeTime: sheet.getRange(CONFIG.HEADER.ROUTE_TIME).getDisplayValue()
    };

    const range = sheet.getDataRange();
    const values = range.getDisplayValues();
    const notes = range.getNotes();

    const tables = findTablesWithNotes_(values, notes);
    return { success: true, fileId, fileName: ss.getName(), header, tables };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function searchPendingSignatures(payload) {
  try {
    payload = payload || {};
    const folderId = String(payload.folderId || "").trim() || CONFIG.DRIVE_ROOT_FOLDER_ID;
    const includeSubfolders = !!payload.includeSubfolders;
    const fileNameContains = String(payload.fileNameContains || "").trim().toLowerCase();
    const startDate = parseDateValue_(payload.startDate);
    const endDate = parseDateValue_(payload.endDate);

    if (!isFolderUnderRoot_(folderId, CONFIG.DRIVE_ROOT_FOLDER_ID)) {
      throw new Error("Folder is outside the allowed ROOT.");
    }

    const files = [];
    collectSheetFiles_(DriveApp.getFolderById(folderId), includeSubfolders, files, {});

    const results = [];
    files.forEach(file => {
      const name = file.getName();
      if (fileNameContains && !name.toLowerCase().includes(fileNameContains)) return;

      const ss = SpreadsheetApp.openById(file.getId());
      const sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getSheets()[0];

      const header = {
        date: sheet.getRange(CONFIG.HEADER.DATE).getDisplayValue(),
        driver: sheet.getRange(CONFIG.HEADER.DRIVER).getDisplayValue(),
        routeTime: sheet.getRange(CONFIG.HEADER.ROUTE_TIME).getDisplayValue()
      };

      const routeDate = parseDateValue_(header.date);
      if (startDate && routeDate && routeDate < startDate) return;
      if (endDate && routeDate && routeDate > endDate) return;

      const range = sheet.getDataRange();
      const values = range.getDisplayValues();
      const notes = range.getNotes();
      const tables = findTablesWithNotes_(values, notes);

      tables.forEach(table => {
        (table.data || []).forEach(pkg => {
          const signed = !!(pkg.signatureImg && pkg.signatureImg.trim());
          if (signed) return;
          const firstPhoto = (pkg.photos && pkg.photos.length) ? pkg.photos[0] : null;
          results.push({
            fileId: file.getId(),
            fileName: name,
            fileUrl: file.getUrl(),
            rowNumber: pkg.rowNumber,
            description: pkg.description || "",
            receiver: pkg.receiver || "",
            location: pkg.location || "",
            photoThumb: firstPhoto && firstPhoto.base64 ? firstPhoto.base64 : "",
            photoId: firstPhoto && firstPhoto.id ? firstPhoto.id : "",
            routeDate: header.date || "",
            routeTime: header.routeTime || "",
            driver: header.driver || "",
            tableTitle: table.title || ""
          });
        });
      });
    });

    return { success: true, results };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function collectSheetFiles_(folder, includeSubfolders, out, visited) {
  const folderId = folder.getId();
  if (visited[folderId]) return;
  visited[folderId] = true;

  const filesIt = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (filesIt.hasNext()) out.push(filesIt.next());

  if (!includeSubfolders) return;
  const foldersIt = folder.getFolders();
  while (foldersIt.hasNext()) {
    collectSheetFiles_(foldersIt.next(), includeSubfolders, out, visited);
  }
}

function parseDateValue_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === "[object Date]") return value;

  const s = String(value).trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (mdy) {
    const mm = Number(mdy[1]);
    const dd = Number(mdy[2]);
    const yy = (mdy[3].length === 4) ? Number(mdy[3]) : Number("20" + mdy[3]);
    return new Date(yy, mm - 1, dd);
  }

  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return parsed;
  return null;
}

function findTablesWithNotes_(values, notes) {
  const tables = [];
  let current = null;

  for (let r = 0; r < values.length; r++) {
    const row = values[r];
    const first = row[0] || "";
    const firstUpper = String(first).toUpperCase();

    if (firstUpper.includes("PACKAGES SENT FROM")) {
      current = { title: first, headerRow: r + 1, headers: [], data: [] };
      tables.push(current);
      continue;
    }

    if (first === "#" && current) {
      current.headers = row;
      continue;
    }

    const n = row[0];
    if (current && n && !isNaN(Number(n))) {
      const sigNote = (notes && notes[r] && notes[r][CONFIG.COLS.SIGNATURE - 1]) ? String(notes[r][CONFIG.COLS.SIGNATURE - 1]) : "";
      const metaNote = (notes && notes[r] && notes[r][CONFIG.COLS.NOTES - 1]) ? String(notes[r][CONFIG.COLS.NOTES - 1]) : "";
      const priority = parsePriorityFromNote_(metaNote);

      const photos = getPhotoSlotsFromRowNotes_(notes && notes[r] ? notes[r] : []);

      let signatureImg = "";
      if (sigNote.startsWith("SIG:")) signatureImg = "data:image/png;base64," + sigNote.substring(4);

      current.data.push({
        rowNumber: r + 1,
        number: row[0],
        date: row[1] || "",
        sender: row[2] || "",
        description: row[3] || "",
        qty: row[4] || "",
        receiver: row[5] || "",
        location: row[6] || "",
        signature: row[7] || "",
        signatureImg: signatureImg,
        notes: row[8] || "",
        priority: priority,
        photos: photos
      });
    }
  }
  return tables;
}

/*****************
 * PACKAGES: Add / Update / Delete
 *****************/
function addPackage(payload) {
  try {
    payload = payload || {};
    const fileId = String(payload.fileId || "").trim();
    const tableIndex = Number(payload.tableIndex);
    const p = payload.packageData || {};
    if (!fileId) throw new Error("fileId is required.");

    const ss = SpreadsheetApp.openById(fileId);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getSheets()[0];

    const values = sheet.getDataRange().getDisplayValues();
    const tables = findTablesWithNotes_(values, sheet.getDataRange().getNotes());
    const table = tables[tableIndex];
    if (!table) throw new Error("Table not found.");

    const insertRow = table.headerRow + 1 + table.data.length + 1;

    const newRow = [
      table.data.length + 1,
      p.date || "",
      p.sender || "",
      p.description || "",
      p.qty || 1,
      p.receiver || "",
      p.location || "",
      "", // signature
      p.notes || ""
    ];

    sheet.getRange(insertRow, 1, 1, 9).setValues([newRow]);
    renumberAllTables_(sheet);
    updatePriorityForRow_(sheet, insertRow, p.priority);

    return { success: true, rowNumber: insertRow };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function updatePackage(payload) {
  try {
    payload = payload || {};
    const fileId = String(payload.fileId || "").trim();
    const rowNumber = Number(payload.rowNumber);
    const u = payload.updates || {};
    if (!fileId) throw new Error("fileId is required.");
    if (!rowNumber) throw new Error("rowNumber is required.");

    const ss = SpreadsheetApp.openById(fileId);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getSheets()[0];

    const range = sheet.getRange(rowNumber, 1, 1, 9);
    const row = range.getValues()[0];

    if (u.date !== undefined) row[1] = u.date;
    if (u.sender !== undefined) row[2] = u.sender;
    if (u.description !== undefined) row[3] = u.description;
    if (u.qty !== undefined) row[4] = u.qty;
    if (u.receiver !== undefined) row[5] = u.receiver;
    if (u.location !== undefined) row[6] = u.location;
    if (u.notes !== undefined) row[8] = u.notes;

    range.setValues([row]);

    if (u.priority !== undefined) updatePriorityForRow_(sheet, rowNumber, u.priority);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function deletePackage(payload) {
  try {
    payload = payload || {};
    const fileId = String(payload.fileId || "").trim();
    const rowNumber = Number(payload.rowNumber);
    if (!fileId) throw new Error("fileId is required.");
    if (!rowNumber) throw new Error("rowNumber is required.");

    const ss = SpreadsheetApp.openById(fileId);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getSheets()[0];

    const sigCol = CONFIG.COLS.SIGNATURE;
    sheet.getImages().forEach(img => {
      try {
        const a = img.getAnchorCell();
        if (a && a.getRow() === rowNumber && a.getColumn() === sigCol) img.remove();
      } catch (e) {}
    });

    // eliminar fotos Drive
    try {
      const photos = getPhotoSlotsForRow_(sheet, rowNumber);
      photos.forEach(p => { try { DriveApp.getFileById(p.id).setTrashed(true); } catch (e) {} });
    } catch (e) {}

    sheet.deleteRow(rowNumber);
    renumberAllTables_(sheet);

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function renumberAllTables_(sheet) {
  const range = sheet.getDataRange();
  const values = range.getDisplayValues();
  const notes = range.getNotes();
  const tables = findTablesWithNotes_(values, notes);

  tables.forEach(t => {
    for (let i = 0; i < t.data.length; i++) {
      const r = t.data[i].rowNumber;
      sheet.getRange(r, CONFIG.COLS.NUMBER).setValue(i + 1);
    }
  });
}

// ---- Priority helpers ----
function normalizePriority_(p){
  const v = String(p || "").trim().toUpperCase();
  if (v === "HIGH" || v === "MED" || v === "LOW") return v;
  return "LOW";
}

function parsePriorityFromNote_(note){
  const m = String(note || "").match(/PRIORITY:\s*(HIGH|MED|LOW)/i);
  return m ? m[1].toUpperCase() : "LOW";
}

function updatePriorityForRow_(sheet, rowNumber, priority){
  const p = normalizePriority_(priority);

  const noteCell = sheet.getRange(rowNumber, CONFIG.COLS.NOTES);
  const prevNote = String(noteCell.getNote() || "");
  const prevPriority = parsePriorityFromNote_(prevNote);

  const cleaned = prevNote.replace(/(^|\n)\s*PRIORITY:\s*(HIGH|MED|LOW)\s*(?=\n|$)/ig, "$1").trim();

  let nextNote = cleaned;
  if (p !== "LOW") {
    nextNote = `PRIORITY:${p}` + (cleaned ? ("\n" + cleaned) : "");
  }

  noteCell.setNote(nextNote);

  const rowRange = sheet.getRange(rowNumber, 1, 1, CONFIG.COLS.PHOTO5);
  if (p === "HIGH") rowRange.setBackground(PRIORITY_HIGH_ROW_COLOR);
  else if (prevPriority === "HIGH") rowRange.setBackground("#ffffff");
}

/*****************
 * WEB APP URL
 *****************/
function getWebAppUrl() {
  try {
    return { success: true, url: ScriptApp.getService().getUrl() };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/*****************
 * PHOTOS: Get package + upload + clear
 *****************/
function getPackageForPhotos(payload) {
  try {
    payload = payload || {};
    const fileId = String(payload.fileId || "").trim();
    const rowNumber = Number(payload.rowNumber);

    if (!fileId || !rowNumber) throw new Error("fileId and rowNumber are required.");

    const ss = SpreadsheetApp.openById(fileId);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getSheets()[0];

    ensurePhotoColumnsFormatting_(sheet);

    const header = {
      date: String(sheet.getRange(CONFIG.HEADER.DATE).getDisplayValue() || ""),
      driver: String(sheet.getRange(CONFIG.HEADER.DRIVER).getDisplayValue() || ""),
      routeTime: String(sheet.getRange(CONFIG.HEADER.ROUTE_TIME).getDisplayValue() || "")
    };

    const rowVals = sheet.getRange(rowNumber, 1, 1, CONFIG.COLS.NOTES).getDisplayValues()[0];
    const rowNotes = sheet.getRange(rowNumber, 1, 1, CONFIG.COLS.PHOTO5).getNotes()[0];

    const sigNote = String(rowNotes[CONFIG.COLS.SIGNATURE - 1] || "");
    const metaNote = String(rowNotes[CONFIG.COLS.NOTES - 1] || "");
    const priority = parsePriorityFromNote_(metaNote);

    let signatureImg = "";
    if (sigNote.startsWith("SIG:")) signatureImg = "data:image/png;base64," + sigNote.substring(4);

    const photos = getPhotoSlotsForRow_(sheet, rowNumber);

    return {
      success: true,
      header,
      package: {
        rowNumber,
        number: rowVals[0] || "",
        date: rowVals[1] || "",
        sender: rowVals[2] || "",
        description: rowVals[3] || "",
        qty: rowVals[4] || "",
        receiver: rowVals[5] || "",
        location: rowVals[6] || "",
        signature: rowVals[7] || "",
        signatureImg: signatureImg,
        notes: rowVals[8] || "",
        priority: priority,
        photos: photos
      }
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function getPackagePhotos(payload) {
  try {
    payload = payload || {};
    const fileId = String(payload.fileId || "").trim();
    const rowNumber = Number(payload.rowNumber);
    if (!fileId || !rowNumber) throw new Error("fileId and rowNumber are required.");

    const ss = SpreadsheetApp.openById(fileId);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getSheets()[0];
    ensurePhotoColumnsFormatting_(sheet);

    const photos = getPhotoSlotsForRow_(sheet, rowNumber);
    return { success: true, photos };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function uploadPackagePhoto(payload) {
  try {
    payload = payload || {};
    const fileId = String(payload.fileId || "").trim();
    const rowNumber = Number(payload.rowNumber);
    const slot = Number(payload.slot);
    const dataUrl = String(payload.dataUrl || "");
    const filename = String(payload.filename || "").trim() || ("photo_" + slot + ".jpg");
    const thumbDataUrl = String(payload.thumbDataUrl || ""); // ✅ NUEVO

    if (!fileId || !rowNumber) throw new Error("fileId and rowNumber are required.");
    if (!slot || slot < 1 || slot > PHOTO_MAX_SLOTS) throw new Error("Invalid slot. Use 1-5.");
    if (!dataUrl || dataUrl.indexOf("data:image") !== 0) throw new Error("Invalid image data.");

    const comma = dataUrl.indexOf(",");
    if (comma === -1) throw new Error("Invalid image data.");

    const meta = dataUrl.substring(0, comma);
    const base64 = dataUrl.substring(comma + 1);

    const m = meta.match(/data:(image\/[a-zA-Z0-9.+-]+);base64/);
    const contentType = (m && m[1]) ? m[1] : "image/jpeg";

    const bytes = Utilities.base64Decode(base64);
    const originalBlob = Utilities.newBlob(bytes, contentType, filename);

    // ✅ RESIZE/REDUCE real (para no reventar insertImage)
    let finalBlob;
    const compressionResult = compressImageIfNeeded_(originalBlob, filename);
    finalBlob = compressionResult.blob;

    // Guardar en Drive (carpeta de fotos)
    const photoFolder = getPhotoFolder_();
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmmss");
    const safeName = filename.replace(/[\/\:*?"<>|]/g, "-");
    const file = photoFolder.createFile(finalBlob).setName(`PKG_${fileId}_R${rowNumber}_S${slot}_${stamp}_${safeName}`);

    // Permitir ver con link
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch(e) {
      console.log("Could not set sharing permissions:", e.message);
    }

    // Insertar thumbnail en sheet como imagen (igual que firmas)
    const ss = SpreadsheetApp.openById(fileId);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getSheets()[0];
    ensurePhotoColumnsFormatting_(sheet);

    const col = CONFIG.COLS.PHOTO1 + (slot - 1);
    const cell = sheet.getRange(rowNumber, col);

    // Eliminar imagen previa en ese slot
    try {
      sheet.getImages().forEach(img => {
        try {
          const anchor = img.getAnchorCell();
          if (anchor && anchor.getRow() === rowNumber && anchor.getColumn() === col) img.remove();
        } catch (e) {}
      });

      const prevId = parsePhotoIdFromNote_(cell.getNote());
      if (prevId) {
        try { DriveApp.getFileById(prevId).setTrashed(true); } catch(e) {}
      }
    } catch(e) {}

    // Insertar imagen en la celda
    const image = sheet.insertImage(finalBlob, col, rowNumber);
    image.setWidth(120);
    image.setHeight(90);

    cell.clearContent();

    // ✅ Guardar ID + thumbnail base64 en la nota (base64 “tipo firma” pero pequeño)
    let note = PHOTO_NOTE_PREFIX + file.getId();
    if (thumbDataUrl && thumbDataUrl.indexOf("data:image") === 0 && thumbDataUrl.length < 45000) {
      note += "\n" + PHOTO_THUMB_NOTE_PREFIX + thumbDataUrl;
    }
    cell.setNote(note);

    try { sheet.setRowHeight(rowNumber, 100); } catch(e) {}

    const photos = getPhotoSlotsForRow_(sheet, rowNumber);
    return { success: true, photos };
  } catch (err) {
    console.log("Error general en uploadPackagePhoto:", err.message);
    return { success: false, error: String(err) };
  }
}

function clearPackagePhoto(payload) {
  try {
    payload = payload || {};
    const fileId = String(payload.fileId || "").trim();
    const rowNumber = Number(payload.rowNumber);
    const slot = Number(payload.slot);

    if (!fileId || !rowNumber) throw new Error("fileId and rowNumber are required.");
    if (!slot || slot < 1 || slot > PHOTO_MAX_SLOTS) throw new Error("Invalid slot. Use 1-5.");

    const ss = SpreadsheetApp.openById(fileId);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getSheets()[0];
    ensurePhotoColumnsFormatting_(sheet);

    const col = CONFIG.COLS.PHOTO1 + (slot - 1);
    const cell = sheet.getRange(rowNumber, col);

    // Eliminar imagen insertada del sheet
    sheet.getImages().forEach(img => {
      try {
        const anchor = img.getAnchorCell();
        if (anchor && anchor.getRow() === rowNumber && anchor.getColumn() === col) img.remove();
      } catch (e) {}
    });

    // Eliminar archivo Drive
    try {
      const id = parsePhotoIdFromNote_(cell.getNote());
      if (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch(e) {} }
    } catch(e) {}

    cell.clearContent();
    cell.setNote("");

    const photos = getPhotoSlotsForRow_(sheet, rowNumber);
    return { success: true, photos };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function getPhotoFolder_() {
  try {
    return DriveApp.getFolderById(CONFIG.PHOTOS_FOLDER_ID);
  } catch (e) {
    // fallback: crea dentro de root (pero ideal: arreglar el ID si está malo)
    try {
      return DriveApp.getFolderById(CONFIG.DRIVE_ROOT_FOLDER_ID).createFolder("Package Photos");
    } catch (e2) {
      // último recurso
      return DriveApp.createFolder("Package Photos");
    }
  }
}

/*****************
 * SIGNATURE: direct save
 *****************/
function saveSignatureDirect(payload) {
  try {
    payload = payload || {};
    const fileId = String(payload.fileId || "").trim();
    const rowNumber = Number(payload.rowNumber);
    const signatureData = String(payload.signatureData || "");
    const receiverName = String(payload.receiverName || "").trim();

    if (!fileId || !rowNumber) throw new Error("fileId and rowNumber are required.");
    if (!signatureData || signatureData.indexOf("data:image") !== 0) throw new Error("Invalid signature data.");
    if (!receiverName) throw new Error("Receiver name is required.");

    const res = saveSignature_({ fileId, rowNumber, signatureData, receiverName });
    if (!res.success) throw new Error(res.error);

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/*****************
 * SIGNATURE LINKS (remote signing)
 *****************/
function createSignatureLink(payload) {
  try {
    payload = payload || {};
    const fileId = String(payload.fileId || "").trim();
    const rowNumber = Number(payload.rowNumber);

    if (!fileId || !rowNumber) throw new Error("fileId and rowNumber are required.");

    const token = Utilities.getUuid().replace(/-/g, "");
    const expires = Date.now() + CONFIG.TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

    PropertiesService.getScriptProperties().setProperty(
      CONFIG.TOKEN_PREFIX + token,
      JSON.stringify({ fileId, rowNumber, expires })
    );

    const url = ScriptApp.getService().getUrl() + "?token=" + encodeURIComponent(token);
    return { success: true, url, token, expires };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function getPackageForSignature(payload) {
  try {
    payload = payload || {};
    const token = String(payload.token || "").trim();
    if (!token) throw new Error("token is required.");

    const data = getToken_(token);

    const fileData = getFileData({ fileId: data.fileId });
    if (!fileData.success) throw new Error(fileData.error);

    let target = null;
    for (const table of fileData.tables) {
      for (const pkg of table.data) {
        if (Number(pkg.rowNumber) === Number(data.rowNumber)) {
          target = pkg;
          break;
        }
      }
      if (target) break;
    }
    if (!target) throw new Error("Package not found.");

    return {
      success: true,
      fileId: data.fileId,
      rowNumber: data.rowNumber,
      header: fileData.header,
      package: target
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function saveSignatureFromToken(payload) {
  try {
    payload = payload || {};
    const token = String(payload.token || "").trim();
    const signatureData = String(payload.signatureData || "");
    const receiverName = String(payload.receiverName || "").trim();

    if (!token) throw new Error("token is required.");
    if (!receiverName) throw new Error("Receiver name is required.");
    if (!signatureData || signatureData.indexOf("data:image") !== 0) throw new Error("Invalid signature data.");

    const data = getToken_(token);

    const res = saveSignature_({
      fileId: data.fileId,
      rowNumber: data.rowNumber,
      signatureData,
      receiverName
    });
    if (!res.success) throw new Error(res.error);

    PropertiesService.getScriptProperties().deleteProperty(CONFIG.TOKEN_PREFIX + token);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function getToken_(token) {
  const raw = PropertiesService.getScriptProperties().getProperty(CONFIG.TOKEN_PREFIX + token);
  if (!raw) throw new Error("Invalid or expired link.");

  const data = JSON.parse(raw);
  if (!data.expires || Date.now() > data.expires) {
    PropertiesService.getScriptProperties().deleteProperty(CONFIG.TOKEN_PREFIX + token);
    throw new Error("This link has expired.");
  }
  return data;
}

function saveSignature_(payload) {
  try {
    const fileId = String(payload.fileId || "").trim();
    const rowNumber = Number(payload.rowNumber);
    const signatureData = String(payload.signatureData || "");
    const receiverName = String(payload.receiverName || "").trim();

    const ss = SpreadsheetApp.openById(fileId);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getSheets()[0];

    const signatureCol = CONFIG.COLS.SIGNATURE;
    const signatureCell = sheet.getRange(rowNumber, signatureCol);

    sheet.getImages().forEach(img => {
      try {
        const a = img.getAnchorCell();
        if (a && a.getRow() === rowNumber && a.getColumn() === signatureCol) img.remove();
      } catch (e) {}
    });

    const base64Data = signatureData.split(",")[1];
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), "image/png", `signature_${rowNumber}.png`);

    const image = sheet.insertImage(blob, signatureCol, rowNumber);
    image.setWidth(180);
    image.setHeight(60);

    const ts = new Date().toLocaleString();
    signatureCell.setValue("SIGNED " + ts);
    signatureCell.setNote("SIG:" + base64Data);

    sheet.getRange(rowNumber, CONFIG.COLS.RECEIVER).setValue(receiverName);
    sheet.setRowHeight(rowNumber, 100);

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Opcional: limpiar fotos viejas
function cleanupOldPhotos(daysOld = 30) {
  try {
    const photoFolder = getPhotoFolder_();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    const files = photoFolder.getFiles();
    let count = 0;

    while (files.hasNext()) {
      const file = files.next();
      if (file.getDateCreated() < cutoff) {
        file.setTrashed(true);
        count++;
      }
    }
    return { success: true, message: `Deleted ${count} old photos` };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
