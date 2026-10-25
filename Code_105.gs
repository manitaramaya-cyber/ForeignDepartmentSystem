/**
 * ระบบแผนกภาษาต่างประเทศ RAV — Login กลาง (ID + PIN) + Dashboard แยกตาม role
 * ผูกสคริปต์นี้กับ Google Sheet: Extensions > Apps Script
 * Deploy: Execute as = Me, Who has access = Anyone
 * หมายเหตุ: ฟังก์ชันที่ลงท้ายด้วย _ เป็น private เรียกจากหน้าเว็บไม่ได้
 */
const APP_TITLE = 'ระบบแผนกภาษาต่างประเทศ';
const EXPIRY_DAYS = 90;      // เตือนสัญญา / work permit / วีซ่า หมดอายุล่วงหน้ากี่วัน
const PASSPORT_DAYS = 180;   // เตือนพาสปอร์ตหมดอายุล่วงหน้ากี่วัน
const APP_VERSION = '1.0.0-hr1a'; // แสดงที่แถบล่างของทุกหน้า
const TZ = 'Asia/Bangkok';
const SESSION_SEC = 6 * 3600; // อยู่ในระบบได้ 6 ชม. (ต่ออายุเมื่อใช้งาน)
const MAX_FAILS = 5;          // ใส่รหัสผิดได้กี่ครั้ง
const LOCK_SEC = 15 * 60;     // พักสิทธิ์กี่วินาที
const MIN_PW = 6;             // รหัสใหม่อย่างน้อยกี่ตัวอักษร

// คอลัมน์ร่วมของทั้ง 4 หมวดงาน (note = ความเห็นของผู้ตรวจ)
const COMMON = ['id', 'teacherId', 'subject', 'class', 'term', 'kind', 'title', 'fileUrl', 'status',
                'submittedAt', 'reviewedBy', 'reviewedAt', 'note', 'updatedAt'];
// ประเภทย่อย: คะแนนเก็บ = PAA..FS2 ; ข้อสอบ = Midterm/Final
// Score_A (Grade 1-6) กรอกครบ 8 ช่วง ; Score_B (Grade 7-9) กรอก 4 ช่วงของภาคที่สอน
const KINDS = { Scores: ['PAA', 'MS1', 'PAB', 'FS1', 'PAC', 'MS2', 'PAD', 'FS2'], Exams: ['Midterm', 'Final'] };

const SCHEMA = {
  Users:       ['userId', 'name', 'email', 'role', 'scope', 'active', 'pinHash', 'salt', 'mustChange', 'setPin'],
  MasterPlans: COMMON,
  Scores:      COMMON,
  Activities:  COMMON,
  Exams:       COMMON,
  // โปรไฟล์ครูต่างชาติ (1 แถวต่อครู 1 คน) staffId = userId ของครูในชีต Users ; salary เห็นได้เฉพาะ 5 คนที่กำหนด
  Staff:       ['staffId', 'nationality', 'dob', 'passportNo', 'passportExpiry', 'visaType', 'visaNo', 'visaExpiry', 'wpNo',
                'workPermitExpiry', 'contractStart', 'contractEnd', 'position', 'duties', 'salary', 'notes', 'updatedBy', 'updatedAt'],
  // ไฟล์สแกนของครู (ตัวไฟล์อยู่ในโฟลเดอร์ Drive ส่วนตัว ไม่แชร์ลิงก์) kind = PASSPORT | VISA | WP | PHOTO
  Documents:   ['id', 'staffId', 'kind', 'fileId', 'fileName', 'mime', 'sizeKb', 'docNo', 'docType', 'expiry', 'verified', 'isCurrent',
                'status', 'uploadedBy', 'uploadedAt', 'archivedBy', 'archivedAt'],
  // บันทึกการลาออก (ข้อมูลครูและไฟล์เดิมยังเก็บไว้ครบ บัญชีถูกปิดที่ชีต Users: active = FALSE)
  Separations: ['id', 'staffId', 'name', 'resignDate', 'reason', 'recordedBy', 'recordedAt', 'reinstatedBy', 'reinstatedAt'],
  // สถิติวันทำงาน: amount = จำนวนวัน (ขาด/ลากิจ/ลาป่วย) หรือจำนวนนาที (มาสาย) ; status ACTIVE | VOID (ยกเลิกแต่ไม่ลบ)
  Attendance:  ['id', 'staffId', 'date', 'type', 'amount', 'note', 'status', 'recordedBy', 'recordedAt', 'voidedBy', 'voidedAt'],
  // ที่อยู่อาศัย: type = ON (ในโรงเรียน) | OFF (นอกโรงเรียน) ; Houses = รายการเลขที่บ้านพักในโรงเรียน (คุณกิตติพันธ์เพิ่มแถวเองได้)
  Addresses:   ['staffId', 'type', 'houseNo', 'addressText', 'landlord', 'phone', 'updatedBy', 'updatedAt'],
  Houses:      ['houseNo', 'note'],
  // ออก-เข้าประเทศ: ถ้ามีวันกลับแล้วแต่ tm30Done ยังเป็น FALSE ระบบเตือนที่แผงแจ้งเตือน
  Travel:      ['id', 'staffId', 'exitDate', 'returnDate', 'tm30Done', 'tm30Date', 'note', 'status', 'recordedBy', 'recordedAt'],
  Announcements: ['date', 'title', 'detail', 'createdBy'], // หัวหน้า/ผู้ประสานงานเพิ่มแถวเองได้ date = yyyy-mm-dd
  AuditLog:    ['timestamp', 'userId', 'action', 'detail']
};
const ACADEMIC = { MasterPlans: 'แผนการจัดการเรียนรู้', Scores: 'คะแนนเก็บ', Activities: 'ใบความรู้/ใบงาน/แบบทดสอบ', Exams: 'ข้อสอบ' };
const STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'RETURNED'];
const ROLE_LABEL = {
  HEAD: 'หัวหน้าแผนก', LIAISON: 'ผู้ประสานงานแผนก', TEACHER: 'ครูผู้สอน',
  HR: 'เจ้าหน้าที่ HR', TIER_B: 'ผู้บริหาร (Tier B)'
};

// ================= ติดตั้ง / เมนูผู้ดูแล =================

/** รันครั้งเดียว: สร้างชีต + ใส่รายชื่อเริ่มต้น + สร้างกุญแจเสริมความปลอดภัยของ PIN */
function setupDatabase() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SCHEMA).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    const want = SCHEMA[name];
    const have = sh.getLastRow() >= 1 ? sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].slice(0, want.length) : [];
    // ชีตว่าง หรือมีแต่หัวคอลัมน์เก่าที่ยังไม่มีข้อมูล -> เขียนหัวใหม่ (ชีตที่มีข้อมูลแล้วจะไม่ถูกแตะ)
    if (sh.getLastRow() <= 1 && have.join('|') !== want.join('|')) {
      sh.clear();
      sh.getRange(1, 1, 1, want.length).setValues([want]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    if (name === 'Staff') { // คอลัมน์ข้อความเป็น Text (วันที่/เงินเดือนปล่อยเป็นปกติ)
      ['nationality', 'passportNo', 'visaType', 'visaNo', 'wpNo', 'position', 'duties', 'notes'].forEach(c =>
        sh.getRange(1, want.indexOf(c) + 1, sh.getMaxRows(), 1).setNumberFormat('@'));
    }
    const TXT = { Addresses: ['houseNo', 'addressText', 'landlord', 'phone'], Houses: ['houseNo', 'note'], Attendance: ['note'], Travel: ['note'] };
    (TXT[name] || []).forEach(c => sh.getRange(1, want.indexOf(c) + 1, sh.getMaxRows(), 1).setNumberFormat('@'));
    if (name === 'Separations') {
      ['staffId', 'name', 'reason'].forEach(c => sh.getRange(1, want.indexOf(c) + 1, sh.getMaxRows(), 1).setNumberFormat('@'));
    }
    if (name === 'Documents') {
      ['docNo', 'docType', 'fileName', 'mime'].forEach(c => sh.getRange(1, want.indexOf(c) + 1, sh.getMaxRows(), 1).setNumberFormat('@'));
    }
    if (name === 'Users') { // userId เป็น Text กัน Sheets ตัดเลข 0 นำหน้า (เช่น 001)
      sh.getRange(1, want.indexOf('userId') + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    }
    if (ACADEMIC[name]) { // คอลัมน์ข้อความเป็น Text กัน Sheets แปลง "1/2569" เป็นวันที่
      ['subject', 'class', 'term', 'kind', 'title', 'fileUrl', 'note'].forEach(c =>
        sh.getRange(1, want.indexOf(c) + 1, sh.getMaxRows(), 1).setNumberFormat('@'));
    }
  });
  ensureSetPinCol_(); // ชีต Users เวอร์ชันเก่าที่ยังไม่มีคอลัมน์ setPin
  archiveFolder_(); // สร้างโฟลเดอร์ Drive ส่วนตัวสำหรับไฟล์สแกน (ครั้งแรกจะขอสิทธิ์ใช้ Drive)
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PEPPER')) props.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  const users = ss.getSheetByName('Users');
  if (users.getLastRow() === 1) {
    users.getRange(2, 1, 5, 9).setValues([
      ['head01',    'ตี๋ (ฉัตรชัย)', 'chartchai.ma@rvs.ac.th', 'HEAD',    '',         true, '', '', ''],
      ['liaison01', 'คุณชาคริต',     '', 'LIAISON', '',         true, '', '', ''],
      ['hr01',      'คุณกิตติพันธ์',  '', 'HR',      '',         true, '', '', ''],
      ['tierb01',   'คุณอนุสรณ์',    '', 'TIER_B',  'ACADEMIC', true, '', '', ''],
      ['tierb02',   'คุณณัฐกมล',     '', 'TIER_B',  'HR',       true, '', '', '']
    ]);
  }
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('ระบบแผนก')
    .addItem('ตั้งรหัสตามที่กรอกไว้ในคอลัมน์ setPin', 'applyTypedPins')
    .addSeparator()
    .addItem('ออก PIN สุ่มให้แถวที่เลือก (ในชีต Users)', 'issuePinsSelected')
    .addItem('ออก PIN ให้ทุกคนที่ยังไม่มี', 'issuePinsMissing')
    .addToUi();
}

/** คอลัมน์ setPin ในชีต Users: ที่ให้พิมพ์รหัสชั่วคราว (เป็น Text เพื่อไม่ให้เลข 0 นำหน้าหาย) */
function ensureSetPinCol_() {
  const sh = SpreadsheetApp.getActive().getSheetByName('Users');
  const head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
  let col = head.indexOf('setPin') + 1, added = false;
  if (!col) { col = head.length + 1; sh.getRange(1, col).setValue('setPin').setFontWeight('bold'); added = true; }
  sh.getRange(1, col, sh.getMaxRows(), 1).setNumberFormat('@');
  return { sh: sh, col: col, added: added };
}

/** พี่พิมพ์รหัสของแต่ละคนในคอลัมน์ setPin แล้วกดเมนูนี้ ระบบเข้ารหัสเก็บ และลบตัวที่พิมพ์ทิ้งทันที */
function applyTypedPins() {
  const ui = SpreadsheetApp.getUi(); // เรียกได้เฉพาะจากเมนูในชีต
  const e = ensureSetPinCol_();
  if (e.added) return ui.alert('เพิ่มคอลัมน์ setPin ให้แล้ว', 'พิมพ์รหัสของแต่ละคนในคอลัมน์ setPin (แถวของคนนั้น) แล้วกดเมนูนี้อีกครั้ง', ui.ButtonSet.OK);
  const sh = e.sh, v = sh.getDataRange().getValues(), head = v[0];
  const c = n => head.indexOf(n);
  const todo = [];
  for (let i = 1; i < v.length; i++) if (String(v[i][c('setPin')]).trim() !== '' && String(v[i][c('userId')]).trim() !== '') todo.push(i);
  if (!todo.length) return ui.alert('ยังไม่มีรหัสในคอลัมน์ setPin', 'พิมพ์รหัสในแถวของคนที่ต้องการตั้ง แล้วกดเมนูนี้อีกครั้ง', ui.ButtonSet.OK);

  const ans = ui.alert('ให้ผู้ใช้ตั้งรหัสใหม่เองตอนเข้าครั้งแรกไหม?',
    'YES = ต้องเปลี่ยนรหัสตอนเข้าครั้งแรก (แนะนำ)\nNO = ใช้รหัสที่พี่ตั้งต่อได้เลย', ui.ButtonSet.YES_NO_CANCEL);
  if (ans === ui.Button.CANCEL) return;

  const done = [], skipped = [];
  todo.forEach(i => {
    const id = String(v[i][c('userId')]).trim(), pw = String(v[i][c('setPin')]).trim();
    if (pw.length < MIN_PW) return skipped.push(id + ' — สั้นไป (อย่างน้อย ' + MIN_PW + ' ตัวอักษร)');
    if (norm_(pw) === norm_(id)) return skipped.push(id + ' — รหัสเหมือน ID');
    const salt = Utilities.getUuid();
    sh.getRange(i + 1, c('salt') + 1).setValue(salt);
    sh.getRange(i + 1, c('pinHash') + 1).setValue(hash_(pw, salt));
    sh.getRange(i + 1, c('mustChange') + 1).setValue(ans === ui.Button.YES);
    sh.getRange(i + 1, c('setPin') + 1).setValue(''); // ลบรหัสที่พิมพ์ทิ้ง
    CacheService.getScriptCache().remove('fail:' + norm_(id)); // ปลดล็อกด้วย
    log_('admin', 'PIN_SET', id);
    done.push(id);
  });
  ui.alert('ตั้งรหัสแล้ว ' + done.length + ' คน',
    (done.length ? 'สำเร็จ: ' + done.join(', ') + '\n(รหัสที่พิมพ์ไว้ถูกลบออกจากชีตแล้ว)' : '') +
    (skipped.length ? '\n\nข้าม (ยังค้างอยู่ในคอลัมน์ setPin ให้แก้แล้วกดใหม่):\n' + skipped.join('\n') : ''), ui.ButtonSet.OK);
}

function issuePinsSelected() {
  const ui = SpreadsheetApp.getUi(); // เรียกได้เฉพาะจากเมนูในชีต
  const sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== 'Users') return ui.alert('กรุณาเลือกแถวในชีต Users ก่อน');
  const r = sh.getActiveRange();
  const rows = [];
  for (let i = r.getRow(); i <= r.getLastRow(); i++) if (i >= 2) rows.push(i);
  issuePins_(sh, rows, ui);
}

function issuePinsMissing() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActive().getSheetByName('Users');
  const v = sh.getDataRange().getValues();
  const head = v[0], rows = [];
  for (let i = 1; i < v.length; i++) if (v[i][head.indexOf('userId')] && !v[i][head.indexOf('pinHash')]) rows.push(i + 1);
  if (!rows.length) return ui.alert('ทุกคนมี PIN แล้ว');
  issuePins_(sh, rows, ui);
}

function issuePins_(sh, rowNums, ui) {
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const col = n => head.indexOf(n) + 1;
  const lines = [];
  rowNums.forEach(row => {
    const id = sh.getRange(row, col('userId')).getValue();
    if (!id) return;
    const pin = randomPin_(), salt = Utilities.getUuid();
    sh.getRange(row, col('salt')).setValue(salt);
    sh.getRange(row, col('pinHash')).setValue(hash_(pin, salt));
    sh.getRange(row, col('mustChange')).setValue(true);
    CacheService.getScriptCache().remove('fail:' + norm_(id)); // ปลดล็อกด้วย
    lines.push(id + '  (' + sh.getRange(row, col('name')).getValue() + ')  →  PIN ' + pin);
    log_('admin', 'PIN_ISSUED', id);
  });
  ui.alert('PIN ที่ออกให้ (แสดงครั้งเดียว — แจกให้เจ้าตัวแบบส่วนตัว ระบบจะบังคับให้เปลี่ยนตอนเข้าครั้งแรก)', lines.join('\n') || 'ไม่มีแถวที่ออก PIN ได้', ui.ButtonSet.OK);
}

// ================= หน้าเว็บ + Login =================

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle(APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** เข้าสู่ระบบ: คืน {ok, token, mustChange} หรือ {ok:false, message} */
function login(userId, pin) {
  const id = norm_(userId), cache = CacheService.getScriptCache();
  const fails = Number(cache.get('fail:' + id) || 0);
  if (fails >= MAX_FAILS) {
    log_(id, 'LOGIN_LOCKED', '');
    return { ok: false, code: 'LOCKED', message: 'ใส่รหัสผิดเกินกำหนด กรุณารอ 15 นาที หรือแจ้งผู้ดูแลเพื่อออก PIN ใหม่' };
  }
  const u = id ? findUser_(id) : null;
  if (!u || !u.pinHash || !isActive_(u) || hash_(String(pin || ''), String(u.salt)) !== String(u.pinHash)) {
    cache.put('fail:' + id, String(fails + 1), LOCK_SEC);
    log_(id, 'LOGIN_FAIL', '');
    return { ok: false, code: 'BAD_LOGIN', message: 'ID หรือ PIN ไม่ถูกต้อง' };
  }
  cache.remove('fail:' + id);
  const token = Utilities.getUuid() + Utilities.getUuid();
  cache.put('s:' + token, id, SESSION_SEC);
  log_(id, 'LOGIN_OK', '');
  return { ok: true, token: token, mustChange: isTrue_(u.mustChange) };
}

function logout(token) {
  if (token) CacheService.getScriptCache().remove('s:' + token);
  return true;
}

function changePin(token, oldPin, newPin) {
  const u = authUser_(token, true);
  const rec = findUser_(u.id);
  if (hash_(String(oldPin || ''), String(rec.salt)) !== String(rec.pinHash)) return { ok: false, code: 'OLD_WRONG', message: 'รหัสเดิมไม่ถูกต้อง' };
  newPin = String(newPin || '');
  if (newPin.length < MIN_PW) return { ok: false, code: 'NEW_SHORT', min: MIN_PW, message: 'รหัสใหม่ต้องยาวอย่างน้อย ' + MIN_PW + ' ตัวอักษร' };
  if (newPin === String(oldPin)) return { ok: false, code: 'NEW_SAME', message: 'รหัสใหม่ต้องไม่ซ้ำรหัสเดิม' };
  const salt = Utilities.getUuid();
  updateUser_(u.id, { salt: salt, pinHash: hash_(newPin, salt), mustChange: false });
  log_(u.id, 'PIN_CHANGED', '');
  return { ok: true };
}

/** ข้อมูล Dashboard — เช็ก session + สิทธิ์ฝั่ง server ทุกครั้ง */
function getDashboardData(token) {
  const user = authUser_(token, false);
  const view = viewFor_(user);
  const out = { view: view, name: user.name, roleLabel: ROLE_LABEL[user.role] || user.role, userId: user.id, role: user.role, academic: null, hr: null,
                version: APP_VERSION,
                perms: { submit: user.role === 'TEACHER', review: isReviewer_(user), staff: canViewStaff_(user), editStaff: canEditStaff_(user),
                         salary: canSeeSalary_(user), calendar: user.role !== 'TEACHER', manageStaff: canManageStaff_(user), attendance: canViewStaff_(user) },
                generated: Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy HH:mm') };
  // ตารางรายครูเฉพาะ dept / teacher / hr ; Tier B เห็นแค่ตัวเลขและกราฟ
  if (view === 'dept')                   { out.academic = academicBlock_(null, true);    out.hr = hrBlock_(true); }
  else if (view === 'teacher')           { out.academic = academicBlock_(user.id, true); out.myHr = myHr_(user.id); out.announcements = announcements_(); }
  else if (view === 'hr')                { out.hr = hrBlock_(true); }
  else if (view === 'overview_academic') { out.academic = academicBlock_(null, false); }
  else if (view === 'overview_hr')       { out.hr = hrBlock_(false); }
  return out;
}

// ================= Auth helpers (private) =================

function norm_(s) { return String(s || '').toLowerCase().trim(); }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function isActive_(r) { return isTrue_(r.active); }

function hash_(pin, salt) {
  const pepper = PropertiesService.getScriptProperties().getProperty('PEPPER');
  if (!pepper) throw new Error('ยังไม่ได้รัน setupDatabase');
  return Utilities.base64Encode(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, pepper + ':' + salt + ':' + pin, Utilities.Charset.UTF_8));
}

function randomPin_() {
  const b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid());
  let n = 0;
  for (let i = 0; i < b.length; i++) n = (n * 256 + (b[i] & 255)) % 1000000;
  return ('000000' + n).slice(-6);
}

function findUser_(id) { return readSheet_('Users').find(r => norm_(r.userId) === norm_(id)) || null; }

function authUser_(token, allowMustChange) {
  const cache = CacheService.getScriptCache();
  const id = token ? cache.get('s:' + token) : null;
  if (!id) throw new Error('SESSION_EXPIRED');
  const u = findUser_(id);
  if (!u || !isActive_(u)) throw new Error('SESSION_EXPIRED');
  if (!allowMustChange && isTrue_(u.mustChange)) throw new Error('MUST_CHANGE_PIN');
  cache.put('s:' + token, id, SESSION_SEC); // ต่ออายุเมื่อมีการใช้งาน
  return { id: norm_(u.userId), name: u.name, role: String(u.role).toUpperCase().trim(), scope: String(u.scope || '').toUpperCase().trim() };
}

function viewFor_(u) {
  switch (u.role) {
    case 'HEAD':
    case 'LIAISON': return 'dept';
    case 'TEACHER': return 'teacher';
    case 'HR': return 'hr';
    case 'TIER_B': return u.scope === 'HR' ? 'overview_hr' : 'overview_academic';
    default: throw new Error('role ไม่ถูกต้องในชีต Users: ' + u.role);
  }
}

// ================= Data (private) =================

function readSheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getValues();
  const head = values.shift();
  return values.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function updateUser_(id, fields) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName('Users');
    const v = sh.getDataRange().getValues(), head = v[0], idCol = head.indexOf('userId');
    for (let i = 1; i < v.length; i++) {
      if (norm_(v[i][idCol]) === norm_(id)) {
        Object.keys(fields).forEach(k => sh.getRange(i + 1, head.indexOf(k) + 1).setValue(fields[k]));
        return true;
      }
    }
    return false;
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}

function zero_() { const c = {}; STATUSES.forEach(s => c[s] = 0); return c; }

function academicBlock_(onlyId, withTable) {
  const teachers = readSheet_('Users').filter(u =>
    String(u.role).toUpperCase() === 'TEACHER' && isActive_(u) && (!onlyId || norm_(u.userId) === onlyId));
  const keys = Object.keys(ACADEMIC);
  const rows = {};
  const ids = new Set(teachers.map(x => norm_(x.userId))); // ครูที่ลาออกแล้วไม่นับในตัวเลข (ข้อมูลยังอยู่ครบ)
  keys.forEach(k => rows[k] = readSheet_(k).filter(r => ids.has(norm_(r.teacherId))));

  const all = zero_();
  const cats = keys.map(k => {
    const counts = zero_();
    rows[k].forEach(r => { if (counts[r.status] !== undefined) { counts[r.status]++; all[r.status]++; } });
    return { key: k, label: ACADEMIC[k], counts: counts, total: STATUSES.reduce((a, s) => a + counts[s], 0) };
  });

  const block = { teachers: teachers.length, all: all, total: STATUSES.reduce((a, s) => a + all[s], 0), cats: cats, table: null };
  if (withTable) {
    block.head = ['ครูผู้สอน'].concat(keys.map(k => ACADEMIC[k]), ['สถานะ']);
    block.table = teachers.map(u => {
      const id = norm_(u.userId);
      let tot = 0, ok = 0, wait = 0, bad = 0;
      const cells = keys.map(k => {
        const mine = rows[k].filter(r => norm_(r.teacherId) === id);
        const a = mine.filter(r => r.status === 'APPROVED').length;
        tot += mine.length; ok += a;
        wait += mine.filter(r => r.status === 'SUBMITTED').length;
        bad += mine.filter(r => r.status === 'RETURNED').length;
        return mine.length ? a + '/' + mine.length : '–';
      });
      const st = bad ? ['RETURNED', 'bad'] : wait ? ['PENDING', 'warn'] : (tot && ok === tot) ? ['COMPLETE', 'good']
               : tot ? ['IN_PROGRESS', 'mute'] : ['NO_WORK', 'mute'];
      return { cells: [u.name].concat(cells), status: st[0], tone: st[1] };
    });
  }
  return block;
}

function hrBlock_(withTable) {
  const now = new Date();
  const limit = new Date();
  limit.setDate(limit.getDate() + EXPIRY_DAYS);
  const names = {};
  readSheet_('Users').forEach(u => names[norm_(u.userId)] = u.name);
  const actIds = new Set(activeTeachers_().map(x => norm_(x.userId)));
  const rows = readSheet_('Staff').filter(r => actIds.has(norm_(r.staffId)));
  const fields = [['contractEnd', 'สัญญาจ้าง'], ['workPermitExpiry', 'Work permit'], ['visaExpiry', 'วีซ่า']];

  const types = fields.map(f => {
    const dated = rows.filter(r => r[f[0]] instanceof Date);
    const soon = dated.filter(r => r[f[0]] <= limit).length; // รวมที่หมดอายุแล้ว
    const expired = dated.filter(r => r[f[0]] < now).length;
    return { key: f[0], label: f[1], total: dated.length, soon: soon, expired: expired, valid: dated.length - soon };
  });

  const block = { teachers: rows.length, types: types, table: null, expiryDays: EXPIRY_DAYS };
  if (withTable) {
    const fmt = d => d instanceof Date ? Utilities.formatDate(d, TZ, 'dd/MM/yyyy') : '–';
    block.head = ['ครูผู้สอน'].concat(fields.map(f => f[1]), ['สถานะ']);
    block.table = rows.map(r => {
      const ds = fields.map(f => r[f[0]]).filter(d => d instanceof Date);
      const min = ds.length ? Math.min.apply(null, ds) : null;
      const st = min === null ? ['NO_DATA', 'mute'] : min < now ? ['EXPIRED', 'bad'] : min <= limit ? ['SOON', 'warn'] : ['OK', 'good'];
      return { cells: [names[norm_(r.staffId)] || r.staffId].concat(fields.map(f => fmt(r[f[0]]))), status: st[0], tone: st[1] };
    });
  }
  return block;
}

function log_(userId, action, detail) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    SpreadsheetApp.getActive().getSheetByName('AuditLog').appendRow([new Date(), userId, action, detail || '']);
  } catch (err) {
    console.error('บันทึก AuditLog ไม่สำเร็จ: ' + err.message);
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

// ================= งานของครู / การตรวจงาน =================

function isReviewer_(u) { return u.role === 'HEAD' || u.role === 'LIAISON'; }
function fmtDT_(d) { return d instanceof Date ? Utilities.formatDate(d, TZ, 'dd/MM/yyyy HH:mm') : ''; }
function userNames_() { const m = {}; readSheet_('Users').forEach(u => m[norm_(u.userId)] = u.name); return m; }

/** ตัดช่องว่าง จำกัดความยาว และตัดอักขระนำหน้าที่ Sheets อาจตีเป็นสูตร (= + - @) */
function clean_(s, max) {
  return String(s === undefined || s === null ? '' : s).trim().slice(0, max || 200).replace(/^[=+\-@]+/, '');
}

function findRow_(name, id, idCol) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  const v = sh.getDataRange().getValues(), head = v[0], idc = head.indexOf(idCol || 'id');
  for (let i = 1; i < v.length; i++) {
    if (String(v[i][idc]) === String(id)) {
      return { sh: sh, row: i + 1, head: head, obj: Object.fromEntries(head.map((h, j) => [h, v[i][j]])) };
    }
  }
  return null;
}

function setFields_(rec, fields) {
  Object.keys(fields).forEach(k => {
    const c = rec.head.indexOf(k);
    if (c >= 0) rec.sh.getRange(rec.row, c + 1).setValue(fields[k]);
  });
}

function workOut_(cat, r, names) {
  const s = k => String(r[k] === undefined || r[k] === null ? '' : r[k]);
  return { category: cat, id: s('id'), teacher: names[norm_(r.teacherId)] || s('teacherId'), subject: s('subject'),
           class: s('class'), term: s('term'), kind: s('kind'), title: s('title'), fileUrl: s('fileUrl'), status: s('status'),
           submittedAt: fmtDT_(r.submittedAt), reviewedBy: s('reviewedBy'), reviewedAt: fmtDT_(r.reviewedAt), note: s('note'),
           sortKey: r.updatedAt instanceof Date ? r.updatedAt.getTime() : 0 };
}

/** scope = 'mine' (ครู: งานของตัวเอง) | 'pending' (หัวหน้า/ผู้ประสานงาน: งานที่ส่งแล้วรอตรวจ) */
function listWork(token, scope) {
  const u = authUser_(token, false);
  if (scope === 'mine' && u.role !== 'TEACHER') throw new Error('ไม่มีสิทธิ์');
  if (scope === 'pending' && !isReviewer_(u)) throw new Error('ไม่มีสิทธิ์');
  if (scope !== 'mine' && scope !== 'pending') throw new Error('scope ไม่ถูกต้อง');
  const names = userNames_(), out = [], act = new Set(activeTeachers_().map(x => norm_(x.userId)));
  Object.keys(ACADEMIC).forEach(cat => readSheet_(cat).forEach(r => {
    if (!act.has(norm_(r.teacherId))) return;
    if (scope === 'mine' && norm_(r.teacherId) !== u.id) return;
    if (scope === 'pending' && r.status !== 'SUBMITTED') return;
    out.push(workOut_(cat, r, names));
  }));
  out.sort((a, b) => scope === 'mine' ? b.sortKey - a.sortKey : a.sortKey - b.sortKey); // รอตรวจ: เก่าสุดขึ้นก่อน
  return out;
}

/** ครูสร้าง/แก้ไขงาน (แก้ได้เฉพาะสถานะร่างหรือถูกตีกลับ) */
function saveWork(token, category, item) {
  const u = authUser_(token, false);
  if (u.role !== 'TEACHER') throw new Error('เฉพาะครูผู้สอนที่ส่งงานได้');
  if (!ACADEMIC[category]) throw new Error('หมวดงานไม่ถูกต้อง');
  item = item || {};
  const f = { subject: clean_(item.subject, 100), class: clean_(item.class, 100), term: clean_(item.term, 50),
              kind: clean_(item.kind, 30), title: clean_(item.title, 200), fileUrl: String(item.fileUrl || '').trim().slice(0, 1000) };
  if (!f.title) return { ok: false, code: 'TITLE_REQ', message: 'กรุณากรอกชื่อรายการ' };
  if (!f.term) return { ok: false, code: 'TERM_REQ', message: 'กรุณากรอกภาคเรียน/ปีการศึกษา' };
  if (KINDS[category]) { if (KINDS[category].indexOf(f.kind) < 0) return { ok: false, code: 'KIND_REQ', message: 'กรุณาเลือกประเภท' }; }
  else f.kind = '';
  if (f.fileUrl && !/^https:\/\//i.test(f.fileUrl)) return { ok: false, code: 'URL_HTTPS', message: 'ลิงก์ไฟล์ต้องขึ้นต้นด้วย https://' };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const now = new Date();
    if (item.id) {
      const rec = findRow_(category, item.id);
      if (!rec || norm_(rec.obj.teacherId) !== u.id) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
      if (rec.obj.status !== 'DRAFT' && rec.obj.status !== 'RETURNED') return { ok: false, code: 'CANT_EDIT', message: 'แก้ไขไม่ได้ในสถานะนี้' };
      f.status = 'DRAFT'; f.updatedAt = now;
      setFields_(rec, f);
      log_(u.id, 'WORK_SAVE', category + ':' + item.id);
      return { ok: true, id: String(item.id) };
    }
    const id = 'W' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    const row = Object.assign({ id: id, teacherId: u.id, status: 'DRAFT', updatedAt: now }, f);
    SpreadsheetApp.getActive().getSheetByName(category).appendRow(COMMON.map(h => row[h] === undefined ? '' : row[h]));
    log_(u.id, 'WORK_CREATE', category + ':' + id);
    return { ok: true, id: id };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}

function ownDraft_(u, category, id) {
  if (u.role !== 'TEACHER') throw new Error('เฉพาะครูผู้สอน');
  if (!ACADEMIC[category]) throw new Error('หมวดงานไม่ถูกต้อง');
  const rec = findRow_(category, id);
  return rec && norm_(rec.obj.teacherId) === u.id ? rec : null;
}

function submitWork(token, category, id) {
  const u = authUser_(token, false);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const rec = ownDraft_(u, category, id);
    if (!rec) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
    if (rec.obj.status !== 'DRAFT' && rec.obj.status !== 'RETURNED') return { ok: false, code: 'CANT_SUBMIT', message: 'ส่งตรวจไม่ได้ในสถานะนี้' };
    if (!rec.obj.fileUrl) return { ok: false, code: 'LINK_REQ', message: 'กรุณาแนบลิงก์ไฟล์ก่อนส่งตรวจ' };
    const now = new Date();
    setFields_(rec, { status: 'SUBMITTED', submittedAt: now, updatedAt: now });
    log_(u.id, 'WORK_SUBMIT', category + ':' + id);
    return { ok: true };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}

function deleteWork(token, category, id) {
  const u = authUser_(token, false);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const rec = ownDraft_(u, category, id);
    if (!rec) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
    if (rec.obj.status !== 'DRAFT') return { ok: false, code: 'CANT_DELETE', message: 'ลบได้เฉพาะงานที่ยังเป็นร่าง' };
    rec.sh.deleteRow(rec.row);
    log_(u.id, 'WORK_DELETE', category + ':' + id);
    return { ok: true };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}

/** หัวหน้าแผนก/ผู้ประสานงาน อนุมัติหรือตีกลับ (ตีกลับต้องมีเหตุผล) */
function reviewWork(token, category, id, decision, note) {
  const u = authUser_(token, false);
  if (!isReviewer_(u)) throw new Error('ไม่มีสิทธิ์ตรวจงาน');
  if (!ACADEMIC[category]) throw new Error('หมวดงานไม่ถูกต้อง');
  if (decision !== 'APPROVED' && decision !== 'RETURNED') throw new Error('ผลการตรวจไม่ถูกต้อง');
  note = clean_(note, 500);
  if (decision === 'RETURNED' && !note) return { ok: false, code: 'REASON_REQ', message: 'กรุณาเขียนเหตุผลที่ตีกลับ' };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const rec = findRow_(category, id);
    if (!rec) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
    if (rec.obj.status !== 'SUBMITTED') return { ok: false, code: 'NOT_PENDING', message: 'รายการนี้ไม่ได้อยู่ในสถานะรอตรวจแล้ว' };
    const now = new Date();
    setFields_(rec, { status: decision, reviewedBy: u.name, reviewedAt: now, note: note, updatedAt: now });
    log_(u.id, 'WORK_' + decision, category + ':' + id);
    return { ok: true };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}

// ================= ข้อมูลหน้าหลักของครู =================

/** วันหมดอายุเอกสารของครูคนนั้นเอง (สัญญา / work permit / วีซ่า) */
function myHr_(id) {
  const r = readSheet_('Staff').find(x => norm_(x.staffId) === id);
  if (!r) return null;
  const now = Date.now();
  const f = d => d instanceof Date ? { date: Utilities.formatDate(d, TZ, 'yyyy-MM-dd'), days: Math.ceil((d.getTime() - now) / 86400000) } : null;
  return { contractEnd: f(r.contractEnd), workPermitExpiry: f(r.workPermitExpiry), visaExpiry: f(r.visaExpiry) };
}

/** ประกาศบนปฏิทิน (ชีต Announcements: date, title, detail) */
function announcements_() {
  return readSheet_('Announcements').map(r => ({
    date: r.date instanceof Date ? Utilities.formatDate(r.date, TZ, 'yyyy-MM-dd') : String(r.date || '').trim(),
    title: String(r.title || ''), detail: String(r.detail || '')
  })).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a.date) && a.title).slice(-300);
}

// ================= โมดูลคุณกิตติพันธ์ (HR Admin): โปรไฟล์ครูต่างชาติ + แจ้งเตือน =================

function canViewStaff_(u) { return u.role === 'HR' || isReviewer_(u); }                       // ดูโปรไฟล์ครู
function canEditStaff_(u) { return u.role === 'HR'; }                                         // แก้โปรไฟล์ครู
function canSeeSalary_(u) { return ['HEAD', 'LIAISON', 'HR', 'TIER_B'].indexOf(u.role) >= 0; } // เห็นเงินเดือน (ตามที่ ตี๋ กำหนด)

function dStr_(d) { return d instanceof Date ? Utilities.formatDate(d, TZ, 'yyyy-MM-dd') : ''; }
function toDate_(s) {            // '' -> '' ; รูปแบบผิด -> null ; ถูก -> Date (เที่ยงคืนเวลาไทย)
  s = String(s === undefined || s === null ? '' : s).trim();
  if (!s) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? Utilities.parseDate(s, TZ, 'yyyy-MM-dd') : null;
}
function daysTo_(d) { return d instanceof Date ? Math.ceil((d.getTime() - Date.now()) / 86400000) : null; }
function ageOf_(d) {
  if (!(d instanceof Date)) return null;
  const n = new Date();
  let a = n.getFullYear() - d.getFullYear();
  if (n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) a--;
  return a;
}

function staffOut_(u, s, withSalary) {
  s = s || {};
  const t = k => String(s[k] === undefined || s[k] === null ? '' : s[k]);
  const o = { staffId: String(u.userId), name: String(u.name), hasProfile: !!s.staffId,
    nationality: t('nationality'), dob: dStr_(s.dob), age: ageOf_(s.dob),
    passportNo: t('passportNo'), passportExpiry: dStr_(s.passportExpiry), passportDays: daysTo_(s.passportExpiry),
    visaType: t('visaType'), visaNo: t('visaNo'), visaExpiry: dStr_(s.visaExpiry), visaDays: daysTo_(s.visaExpiry),
    wpNo: t('wpNo'), workPermitExpiry: dStr_(s.workPermitExpiry), wpDays: daysTo_(s.workPermitExpiry),
    contractStart: dStr_(s.contractStart), contractEnd: dStr_(s.contractEnd), contractDays: daysTo_(s.contractEnd),
    position: t('position'), duties: t('duties'), notes: t('notes') };
  if (withSalary) o.salary = (s.salary === '' || s.salary === undefined || s.salary === null) ? '' : Number(s.salary);
  return o;
}

function activeTeachers_() {
  return readSheet_('Users').filter(x => String(x.role).toUpperCase() === 'TEACHER' && isActive_(x));
}

/** ตารางรวมครูต่างชาติ (ไม่รวมเงินเดือน) */
function listStaff(token) {
  const u = authUser_(token, false);
  if (!canViewStaff_(u)) throw new Error('ไม่มีสิทธิ์');
  const byId = {};
  readSheet_('Staff').forEach(r => byId[norm_(r.staffId)] = r);
  log_(u.id, 'STAFF_LIST', '');
  return { staff: activeTeachers_().map(x => staffOut_(x, byId[norm_(x.userId)], false)), canEdit: canEditStaff_(u), canSalary: canSeeSalary_(u) };
}

/** โปรไฟล์ละเอียดของครู 1 คน (เงินเดือนแสดงเฉพาะผู้มีสิทธิ์ และบันทึก Log ทุกครั้ง) */
function getStaff(token, staffId) {
  const u = authUser_(token, false);
  if (!canViewStaff_(u)) throw new Error('ไม่มีสิทธิ์');
  const t = readSheet_('Users').find(x => String(x.role).toUpperCase() === 'TEACHER' && norm_(x.userId) === norm_(staffId));
  if (!t) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
  const former = !isActive_(t); // ครูที่ลาออกแล้ว: ดูย้อนหลังได้อย่างเดียว
  const s = readSheet_('Staff').find(r => norm_(r.staffId) === norm_(staffId));
  let resignDate = '';
  if (former) {
    const sep = readSheet_('Separations').filter(r => norm_(r.staffId) === norm_(staffId) && !(r.reinstatedAt instanceof Date)).pop();
    resignDate = sep ? dStr_(sep.resignDate) : '';
  }
  log_(u.id, 'STAFF_VIEW', String(t.userId));
  return { ok: true, staff: staffOut_(t, s, canSeeSalary_(u)), canEdit: canEditStaff_(u) && !former, canManage: canManageStaff_(u) && !former, former: former, resignDate: resignDate };
}

/** คุณกิตติพันธ์ (HR) บันทึกโปรไฟล์ครู */
function saveStaff(token, item) {
  const u = authUser_(token, false);
  if (!canEditStaff_(u)) throw new Error('ไม่มีสิทธิ์แก้ไข');
  item = item || {};
  const t = activeTeachers_().find(x => norm_(x.userId) === norm_(item.staffId));
  if (!t) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
  const dates = {};
  const dateKeys = ['dob', 'passportExpiry', 'visaExpiry', 'workPermitExpiry', 'contractStart', 'contractEnd'];
  for (let i = 0; i < dateKeys.length; i++) {
    const d = toDate_(item[dateKeys[i]]);
    if (d === null) return { ok: false, code: 'DATE_BAD', message: 'รูปแบบวันที่ไม่ถูกต้อง' };
    dates[dateKeys[i]] = d;
  }
  let salary = '';
  const rawSalary = String(item.salary === undefined || item.salary === null ? '' : item.salary).replace(/,/g, '').trim();
  if (rawSalary !== '') {
    salary = Number(rawSalary);
    if (isNaN(salary) || salary < 0) return { ok: false, code: 'SALARY_BAD', message: 'เงินเดือนต้องเป็นตัวเลข' };
  }
  const f = Object.assign({
    staffId: String(t.userId), nationality: clean_(item.nationality, 100), passportNo: clean_(item.passportNo, 50),
    visaType: clean_(item.visaType, 100), visaNo: clean_(item.visaNo, 50), wpNo: clean_(item.wpNo, 50),
    position: clean_(item.position, 150), duties: clean_(item.duties, 500), notes: clean_(item.notes, 1000),
    salary: salary, updatedBy: u.name, updatedAt: new Date()
  }, dates);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    staffSet_(t.userId, f);
    log_(u.id, 'STAFF_SAVE', String(t.userId)); // ไม่บันทึกค่าเงินเดือนลง Log
    return { ok: true };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}

/** แจ้งเตือนเอกสารใกล้หมดอายุ + รายการบนปฏิทิน (ทุกคนที่ไม่ใช่ครู) */
function getHrAlerts(token) {
  const u = authUser_(token, false);
  if (u.role === 'TEACHER') throw new Error('ไม่มีสิทธิ์');
  const active = {};
  activeTeachers_().forEach(x => active[norm_(x.userId)] = String(x.name));
  const kinds = [['workPermitExpiry', EXPIRY_DAYS], ['contractEnd', EXPIRY_DAYS], ['visaExpiry', EXPIRY_DAYS], ['passportExpiry', PASSPORT_DAYS]];
  const alerts = [], events = [];
  readSheet_('Staff').forEach(r => {
    const id = norm_(r.staffId);
    if (!active[id]) return;
    kinds.forEach(k => {
      const d = r[k[0]];
      if (!(d instanceof Date)) return;
      const days = daysTo_(d), date = dStr_(d);
      events.push({ date: date, kind: k[0], staffId: String(r.staffId), name: active[id] });
      if (days <= k[1]) alerts.push({ kind: k[0], staffId: String(r.staffId), name: active[id], date: date, days: days, level: days <= 30 ? 'bad' : 'warn' });
    });
  });
  readSheet_('Travel').filter(r => r.status === 'ACTIVE' && active[norm_(r.staffId)]).forEach(r => { // ออก-เข้าประเทศ + เตือนลงที่พัก (ตม.30)
    const name = active[norm_(r.staffId)], sid = String(r.staffId);
    if (r.exitDate instanceof Date) events.push({ date: dStr_(r.exitDate), kind: 'exit', staffId: sid, name: name });
    if (r.returnDate instanceof Date) {
      events.push({ date: dStr_(r.returnDate), kind: 'return', staffId: sid, name: name });
      const days = daysTo_(r.returnDate);
      if (days <= 0 && !isTrue_(r.tm30Done)) alerts.push({ kind: 'tm30', staffId: sid, name: name, date: dStr_(r.returnDate), days: days, level: 'bad' });
    }
  });
  alerts.sort((a, b) => a.days - b.days);
  events.sort((a, b) => a.date < b.date ? -1 : 1);
  return { alerts: alerts, events: events, expiryDays: EXPIRY_DAYS, passportDays: PASSPORT_DAYS };
}

// ================= ไฟล์สแกนของครู: พาสปอร์ต · วีซ่า · ใบอนุญาตทำงาน · รูปถ่าย =================
// หลักการ: ไฟล์อยู่ในโฟลเดอร์ Drive ส่วนตัวของเจ้าของสคริปต์ (ไม่แชร์ลิงก์) ผู้ใช้เปิดผ่านระบบหลังตรวจสิทธิ์เท่านั้น
// พาสปอร์ต / ใบอนุญาตทำงาน / รูปถ่าย: ไฟล์ใหม่มาแทน ไฟล์เดิมย้ายเข้าที่เก็บ (Archive) และบันทึก Log
// วีซ่า: เก็บประวัติทุกฉบับ ฉบับล่าสุดเป็น "ฉบับปัจจุบัน"
const MAX_PDF = 8 * 1024 * 1024, MAX_IMG = 600 * 1024;
const DOC_KINDS = { PASSPORT: 'pdf', VISA: 'pdf', WP: 'pdf', HOUSE: 'pdf', PHOTO: 'img' }; // HOUSE = เอกสารเจ้าของบ้าน (ไฟล์ใหม่มาแทน ไฟล์เดิมเข้าที่เก็บ)

function filesFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FILES_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* โฟลเดอร์ถูกลบ -> สร้างใหม่ */ } }
  const f = DriveApp.createFolder('RAV_ForeignDept_Private');
  props.setProperty('FILES_FOLDER_ID', f.getId());
  return f;
}
function archiveFolder_() {
  const root = filesFolder_(), it = root.getFoldersByName('Archive');
  return it.hasNext() ? it.next() : root.createFolder('Archive');
}

function sniffMime_(bytes) {
  const b = i => bytes[i] & 255;
  if (bytes.length > 4 && b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) return 'application/pdf';
  if (bytes.length > 3 && b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return 'image/jpeg';
  if (bytes.length > 8 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) return 'image/png';
  return '';
}

/** เขียนค่า "ปัจจุบัน" ลงชีต Staff (สร้างแถวให้ถ้ายังไม่มี) */
function staffSet_(staffId, fields) {
  const f = Object.assign({ staffId: String(staffId) }, fields);
  const rec = findRow_('Staff', String(staffId), 'staffId');
  if (rec) setFields_(rec, f);
  else SpreadsheetApp.getActive().getSheetByName('Staff').appendRow(SCHEMA.Staff.map(h => f[h] === undefined ? '' : f[h]));
}

function docOut_(r) {
  return { id: String(r.id), kind: String(r.kind), fileName: String(r.fileName || ''), sizeKb: Number(r.sizeKb) || 0, docNo: String(r.docNo || ''),
    docType: String(r.docType || ''), expiry: dStr_(r.expiry), days: daysTo_(r.expiry), verified: isTrue_(r.verified), isCurrent: isTrue_(r.isCurrent),
    status: String(r.status || ''), uploadedBy: String(r.uploadedBy || ''), uploadedAt: fmtDT_(r.uploadedAt) };
}

function moveToArchive_(fileId) {
  try { DriveApp.getFileById(fileId).moveTo(archiveFolder_()); } catch (e) { console.error('ย้ายไฟล์เข้าที่เก็บไม่สำเร็จ: ' + e.message); }
}

/** รายการไฟล์ของครู 1 คน (ที่เก็บเดิม/ARCHIVED เห็นเฉพาะคุณกิตติพันธ์) */
function listDocs(token, staffId) {
  const u = authUser_(token, false);
  if (!canViewStaff_(u)) throw new Error('ไม่มีสิทธิ์');
  const withArchived = canEditStaff_(u);
  const docs = readSheet_('Documents')
    .filter(r => norm_(r.staffId) === norm_(staffId) && r.kind !== 'PHOTO' && (withArchived || r.status === 'ACTIVE'))
    .sort((a, b) => (b.uploadedAt instanceof Date ? b.uploadedAt.getTime() : 0) - (a.uploadedAt instanceof Date ? a.uploadedAt.getTime() : 0))
    .map(docOut_);
  const tt = readSheet_('Users').find(x => String(x.role).toUpperCase() === 'TEACHER' && norm_(x.userId) === norm_(staffId));
  return { docs: docs, canEdit: canEditStaff_(u) && !!tt && isActive_(tt) };
}

/** อัปโหลดไฟล์สแกน (คุณกิตติพันธ์เท่านั้น) b64 = เนื้อไฟล์แบบ base64 ไม่มีหัว data: */
function uploadDoc(token, staffId, kind, meta, b64) {
  const u = authUser_(token, false);
  if (!canEditStaff_(u)) throw new Error('ไม่มีสิทธิ์แก้ไข');
  if (!DOC_KINDS[kind]) throw new Error('ประเภทเอกสารไม่ถูกต้อง');
  const t = activeTeachers_().find(x => norm_(x.userId) === norm_(staffId));
  if (!t) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
  meta = meta || {};
  b64 = String(b64 || '');
  if (!b64) return { ok: false, code: 'FILE_NONE', message: 'กรุณาเลือกไฟล์' };
  const isPdf = DOC_KINDS[kind] === 'pdf', max = isPdf ? MAX_PDF : MAX_IMG;
  if (b64.length > Math.ceil(max * 4 / 3) + 8) return { ok: false, code: 'FILE_BIG', message: 'ไฟล์ใหญ่เกินไป' };
  let bytes;
  try { bytes = Utilities.base64Decode(b64); } catch (e) { return { ok: false, code: isPdf ? 'FILE_TYPE' : 'IMG_TYPE', message: 'อ่านไฟล์ไม่ได้' }; }
  if (bytes.length > max) return { ok: false, code: 'FILE_BIG', message: 'ไฟล์ใหญ่เกินไป' };
  const mime = sniffMime_(bytes); // ตรวจจากเนื้อไฟล์จริง ไม่เชื่อนามสกุลที่ส่งมา
  if (isPdf ? mime !== 'application/pdf' : (mime !== 'image/jpeg' && mime !== 'image/png'))
    return { ok: false, code: isPdf ? 'FILE_TYPE' : 'IMG_TYPE', message: 'ชนิดไฟล์ไม่ถูกต้อง' };
  const exp = toDate_(meta.expiry);
  if (exp === null) return { ok: false, code: 'DATE_BAD', message: 'รูปแบบวันที่ไม่ถูกต้อง' };

  const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
  const now = new Date();
  const id = 'D' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  const name = String(t.userId) + '_' + kind + '_' + Utilities.formatDate(now, TZ, 'yyyyMMdd-HHmmss') + '.' + ext;
  const file = filesFolder_().createFile(Utilities.newBlob(bytes, mime, name));

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    readSheet_('Documents').filter(r => norm_(r.staffId) === norm_(t.userId) && r.kind === kind && r.status === 'ACTIVE').forEach(r => {
      const rec = findRow_('Documents', r.id);
      if (!rec) return;
      if (kind === 'VISA') { setFields_(rec, { isCurrent: false }); return; }  // วีซ่าเก่าเก็บไว้ ไม่ย้ายออก
      setFields_(rec, { status: 'ARCHIVED', isCurrent: false, archivedBy: u.name, archivedAt: now });
      moveToArchive_(String(r.fileId));
      log_(u.id, 'DOC_ARCHIVE_AUTO', kind + ':' + r.id);
    });
    const row = { id: id, staffId: String(t.userId), kind: kind, fileId: file.getId(), fileName: name, mime: mime, sizeKb: Math.ceil(bytes.length / 1024),
      docNo: clean_(meta.docNo, 100), docType: clean_(meta.docType, 100), expiry: exp, verified: !!meta.verified, isCurrent: true,
      status: 'ACTIVE', uploadedBy: u.name, uploadedAt: now };
    SpreadsheetApp.getActive().getSheetByName('Documents').appendRow(SCHEMA.Documents.map(h => row[h] === undefined ? '' : row[h]));

    // อัปเดตค่า "ปัจจุบัน" ในโปรไฟล์ให้ตรงกับไฟล์ล่าสุด (ไม่ทับด้วยค่าว่าง)
    const sync = { updatedBy: u.name, updatedAt: now };
    if (kind === 'PASSPORT') { if (row.docNo) sync.passportNo = row.docNo; if (exp !== '') sync.passportExpiry = exp; }
    if (kind === 'WP')       { if (row.docNo) sync.wpNo = row.docNo;       if (exp !== '') sync.workPermitExpiry = exp; }
    if (kind === 'VISA')     { if (row.docType) sync.visaType = row.docType; if (row.docNo) sync.visaNo = row.docNo; if (exp !== '') sync.visaExpiry = exp; }
    if (kind !== 'PHOTO' && kind !== 'HOUSE') staffSet_(t.userId, sync);
    log_(u.id, 'DOC_UPLOAD', String(t.userId) + ':' + kind + ':' + id);
    return { ok: true, id: id };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}

/** ย้ายไฟล์เข้าที่เก็บด้วยมือ (คุณกิตติพันธ์) ไม่ลบจริง */
function archiveDoc(token, docId) {
  const u = authUser_(token, false);
  if (!canEditStaff_(u)) throw new Error('ไม่มีสิทธิ์แก้ไข');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const rec = findRow_('Documents', docId);
    if (!rec || rec.obj.status !== 'ACTIVE') return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
    setFields_(rec, { status: 'ARCHIVED', isCurrent: false, archivedBy: u.name, archivedAt: new Date() });
    moveToArchive_(String(rec.obj.fileId));
    if (rec.obj.kind === 'VISA' && isTrue_(rec.obj.isCurrent)) { // ให้ฉบับที่ใหม่สุดที่เหลือเป็นฉบับปัจจุบัน
      const rest = readSheet_('Documents').filter(r => norm_(r.staffId) === norm_(rec.obj.staffId) && r.kind === 'VISA' && r.status === 'ACTIVE' && String(r.id) !== String(docId))
        .sort((a, b) => (b.uploadedAt instanceof Date ? b.uploadedAt.getTime() : 0) - (a.uploadedAt instanceof Date ? a.uploadedAt.getTime() : 0));
      if (rest.length) { const n = findRow_('Documents', rest[0].id); if (n) setFields_(n, { isCurrent: true }); }
    }
    log_(u.id, 'DOC_ARCHIVE', String(rec.obj.staffId) + ':' + rec.obj.kind + ':' + docId);
    return { ok: true };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}

/** เปิด/ดาวน์โหลดไฟล์: ตรวจสิทธิ์ทุกครั้งและบันทึก Log */
function getDocFile(token, docId) {
  const u = authUser_(token, false);
  if (!canViewStaff_(u)) throw new Error('ไม่มีสิทธิ์');
  const r = readSheet_('Documents').find(x => String(x.id) === String(docId));
  if (!r || r.kind === 'PHOTO') return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
  if (r.status !== 'ACTIVE' && !canEditStaff_(u)) throw new Error('ไม่มีสิทธิ์');
  let blob;
  try { blob = DriveApp.getFileById(String(r.fileId)).getBlob(); } catch (e) { return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบไฟล์ใน Drive' }; }
  log_(u.id, 'DOC_VIEW', String(r.staffId) + ':' + r.kind + ':' + docId);
  return { ok: true, name: String(r.fileName), mime: String(r.mime), b64: Utilities.base64Encode(blob.getBytes()) };
}

/** รูปถ่ายครูทั้งหมด (data URL) สำหรับการ์ดโปรไฟล์ */
function getPhotos(token) {
  const u = authUser_(token, false);
  if (!canViewStaff_(u)) throw new Error('ไม่มีสิทธิ์');
  const out = {};
  readSheet_('Documents').filter(r => r.kind === 'PHOTO' && r.status === 'ACTIVE').forEach(r => {
    try { out[String(r.staffId)] = 'data:' + r.mime + ';base64,' + Utilities.base64Encode(DriveApp.getFileById(String(r.fileId)).getBlob().getBytes()); }
    catch (e) { console.error('อ่านรูปไม่ได้: ' + r.id); }
  });
  return out;
}

// ================= เพิ่มครูใหม่ · ลาออก · รับกลับ (คุณกิตติพันธ์ และ หัวหน้าแผนก) =================

function canManageStaff_(u) { return u.role === 'HR' || u.role === 'HEAD'; }
const ID_RE = /^[A-Za-z0-9._-]{3,30}$/;

function appendByHeader_(name, obj) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.appendRow(head.map(h => obj[h] === undefined ? '' : obj[h]));
}

/** รหัสผ่านที่พิมพ์มา (ตรวจความยาว/ไม่เหมือน ID) หรือเว้นว่าง = ให้ระบบสุ่ม */
function newPassword_(given, id) {
  given = String(given === undefined || given === null ? '' : given).trim();
  if (!given) return { pw: randomPin_(), generated: true };
  if (given.length < MIN_PW) return { error: { ok: false, code: 'PW_SHORT', min: MIN_PW, message: 'รหัสผ่านสั้นเกินไป' } };
  if (norm_(given) === norm_(id)) return { error: { ok: false, code: 'PW_SAME_ID', message: 'รหัสผ่านต้องไม่เหมือน ID' } };
  return { pw: given, generated: false };
}

function teacherUser_(id) { return readSheet_('Users').find(x => String(x.role).toUpperCase() === 'TEACHER' && norm_(x.userId) === norm_(id)) || null; }

/** สร้างบัญชีครูใหม่ — รหัสที่ระบบสุ่มให้จะส่งกลับมาครั้งเดียวเพื่อแจ้งครู ครูต้องเปลี่ยนรหัสตอนเข้าครั้งแรก */
function addStaff(token, item) {
  const u = authUser_(token, false);
  if (!canManageStaff_(u)) throw new Error('ไม่มีสิทธิ์');
  item = item || {};
  const id = String(item.userId || '').trim(), name = clean_(item.name, 100), email = clean_(item.email, 150);
  if (!ID_RE.test(id)) return { ok: false, code: 'ID_BAD', message: 'ID ไม่ถูกต้อง' };
  if (!name) return { ok: false, code: 'NAME_REQ', message: 'กรุณากรอกชื่อ' };
  const pw = newPassword_(item.password, id);
  if (pw.error) return pw.error;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (findUser_(id)) return { ok: false, code: 'ID_TAKEN', message: 'ID นี้ถูกใช้แล้ว' };
    const salt = Utilities.getUuid();
    appendByHeader_('Users', { userId: id, name: name, email: email, role: 'TEACHER', scope: '', active: true, pinHash: hash_(pw.pw, salt), salt: salt, mustChange: true });
    log_(u.id, 'STAFF_ADD', id); // ไม่จดรหัสผ่านลง Log
    return { ok: true, userId: id, password: pw.generated ? pw.pw : null };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}

/** ตั้งรหัสใหม่ให้ครู (ลืมรหัส) — ครูต้องเปลี่ยนรหัสอีกครั้งตอนเข้า */
function resetStaffPin(token, staffId, password) {
  const u = authUser_(token, false);
  if (!canManageStaff_(u)) throw new Error('ไม่มีสิทธิ์');
  const t = teacherUser_(staffId);
  if (!t || !isActive_(t)) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
  const pw = newPassword_(password, t.userId);
  if (pw.error) return pw.error;
  const salt = Utilities.getUuid();
  updateUser_(t.userId, { salt: salt, pinHash: hash_(pw.pw, salt), mustChange: true });
  CacheService.getScriptCache().remove('fail:' + norm_(t.userId)); // ปลดล็อกถ้าเคยโดนล็อก
  log_(u.id, 'PIN_RESET_BY', String(t.userId));
  return { ok: true, password: pw.generated ? pw.pw : null };
}

/** บันทึกการลาออก: ปิดบัญชีทันที ข้อมูลและไฟล์ยังเก็บครบ (ถ้ามีงานรอตรวจ ต้องยืนยันซ้ำด้วย force) */
function resignStaff(token, staffId, resignDate, reason, force) {
  const u = authUser_(token, false);
  if (!canManageStaff_(u)) throw new Error('ไม่มีสิทธิ์');
  const t = teacherUser_(staffId);
  if (!t || !isActive_(t)) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
  const d = toDate_(resignDate);
  if (d === '') return { ok: false, code: 'DATE_REQ', message: 'กรุณาระบุวันที่ลาออก' };
  if (d === null) return { ok: false, code: 'DATE_BAD', message: 'รูปแบบวันที่ไม่ถูกต้อง' };
  let pending = 0;
  Object.keys(ACADEMIC).forEach(k => { pending += readSheet_(k).filter(r => norm_(r.teacherId) === norm_(t.userId) && r.status === 'SUBMITTED').length; });
  if (pending && !force) return { ok: false, code: 'PENDING_WORK', pending: pending, message: 'มีงานรอตรวจ' };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    updateUser_(t.userId, { active: false });
    appendByHeader_('Separations', { id: 'S' + Utilities.getUuid().replace(/-/g, '').slice(0, 8), staffId: String(t.userId), name: String(t.name),
      resignDate: d, reason: clean_(reason, 500), recordedBy: u.name, recordedAt: new Date() });
    log_(u.id, 'STAFF_RESIGN', String(t.userId));
    return { ok: true };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}

/** รับครูกลับเข้าทำงาน: เปิดบัญชี + ตั้งรหัสใหม่ให้ครูเปลี่ยนเองตอนเข้า */
function reinstateStaff(token, staffId, password) {
  const u = authUser_(token, false);
  if (!canManageStaff_(u)) throw new Error('ไม่มีสิทธิ์');
  const t = teacherUser_(staffId);
  if (!t || isActive_(t)) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
  const pw = newPassword_(password, t.userId);
  if (pw.error) return pw.error;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const salt = Utilities.getUuid();
    updateUser_(t.userId, { active: true, salt: salt, pinHash: hash_(pw.pw, salt), mustChange: true });
    CacheService.getScriptCache().remove('fail:' + norm_(t.userId));
    const sep = readSheet_('Separations').filter(r => norm_(r.staffId) === norm_(t.userId) && !(r.reinstatedAt instanceof Date)).pop();
    if (sep) { const rec = findRow_('Separations', sep.id); if (rec) setFields_(rec, { reinstatedBy: u.name, reinstatedAt: new Date() }); }
    log_(u.id, 'STAFF_REINSTATE', String(t.userId));
    return { ok: true, password: pw.generated ? pw.pw : null };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}

/** รายชื่อครูที่ลาออก (รวมบัญชีที่ถูกปิดด้วยมือในชีตโดยไม่มีบันทึก) */
function listFormerStaff(token) {
  const u = authUser_(token, false);
  if (!canViewStaff_(u)) throw new Error('ไม่มีสิทธิ์');
  const seps = {};
  readSheet_('Separations').filter(r => !(r.reinstatedAt instanceof Date)).forEach(r => seps[norm_(r.staffId)] = r);
  const former = readSheet_('Users').filter(x => String(x.role).toUpperCase() === 'TEACHER' && !isActive_(x)).map(x => {
    const s = seps[norm_(x.userId)] || {};
    return { staffId: String(x.userId), name: String(x.name), resignDate: dStr_(s.resignDate), reason: String(s.reason || ''), recordedBy: String(s.recordedBy || ''), recordedAt: fmtDT_(s.recordedAt) };
  }).sort((a, b) => a.resignDate < b.resignDate ? 1 : -1);
  return { former: former, canManage: canManageStaff_(u) };
}

// ================= สถิติวันทำงาน · ที่อยู่อาศัย · ออก-เข้าประเทศ (ตม.30) =================

const ATT_TYPES = ['ABSENT', 'PERSONAL_LEAVE', 'SICK_LEAVE', 'LATE'];
function canRecordAttendance_(u) { return u.role === 'HR' || isReviewer_(u); } // ตี๋ · คุณชาคริต · คุณกิตติพันธ์
function todayStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function uid8_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 8); }

/** สถิติรวมรายครู (from/to = yyyy-MM-dd หรือว่าง) + รายการล่าสุด ; ใส่ staffId เพื่อดูเฉพาะคนเดียว */
function getAttendance(token, from, to, staffId) {
  const u = authUser_(token, false);
  if (!canRecordAttendance_(u)) throw new Error('ไม่มีสิทธิ์');
  const names = userNames_(), teachers = activeTeachers_().map(x => ({ id: String(x.userId), name: String(x.name) }));
  const scope = staffId ? [{ id: String(staffId), name: names[norm_(staffId)] || String(staffId) }] : teachers;
  const ids = new Set(scope.map(x => norm_(x.id)));
  const f = String(from || ''), e = String(to || '');
  const rows = readSheet_('Attendance').filter(r => r.status === 'ACTIVE' && ids.has(norm_(r.staffId)) && (!f || dStr_(r.date) >= f) && (!e || dStr_(r.date) <= e));
  const summary = scope.map(x => { const o = { staffId: x.id, name: x.name }; ATT_TYPES.forEach(k => o[k] = { n: 0, sum: 0 }); return o; });
  const byId = {}; summary.forEach(x => byId[norm_(x.staffId)] = x);
  rows.forEach(r => { const s = byId[norm_(r.staffId)]; if (s && s[r.type]) { s[r.type].n++; s[r.type].sum += Number(r.amount) || 0; } });
  summary.forEach(s => ATT_TYPES.forEach(k => s[k].sum = Math.round(s[k].sum * 10) / 10));
  const records = rows.map(r => ({ id: String(r.id), staffId: String(r.staffId), name: names[norm_(r.staffId)] || String(r.staffId), date: dStr_(r.date), type: String(r.type),
    amount: Number(r.amount) || 0, note: String(r.note || ''), recordedBy: String(r.recordedBy || '') }))
    .sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0).slice(0, 200);
  return { summary: summary, records: records, teachers: teachers, canEdit: canRecordAttendance_(u) };
}

function recordAttendance(token, item) {
  const u = authUser_(token, false);
  if (!canRecordAttendance_(u)) throw new Error('ไม่มีสิทธิ์');
  item = item || {};
  const t = activeTeachers_().find(x => norm_(x.userId) === norm_(item.staffId));
  if (!t) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
  const d = toDate_(item.date);
  if (d === '') return { ok: false, code: 'DATE_NEED', message: 'กรุณาระบุวันที่' };
  if (d === null) return { ok: false, code: 'DATE_BAD', message: 'รูปแบบวันที่ไม่ถูกต้อง' };
  const type = String(item.type || '');
  if (ATT_TYPES.indexOf(type) < 0) return { ok: false, code: 'TYPE_BAD', message: 'ประเภทไม่ถูกต้อง' };
  const amount = Math.round(Number(String(item.amount === undefined || item.amount === null ? '' : item.amount).replace(/,/g, '')) * 10) / 10;
  if (!(amount > 0) || amount > (type === 'LATE' ? 600 : 365)) return { ok: false, code: 'AMOUNT_BAD', message: 'จำนวนไม่ถูกต้อง' };
  appendByHeader_('Attendance', { id: 'A' + uid8_(), staffId: String(t.userId), date: d, type: type, amount: amount, note: clean_(item.note, 300),
    status: 'ACTIVE', recordedBy: u.name, recordedAt: new Date() });
  log_(u.id, 'ATT_ADD', String(t.userId) + ':' + type + ':' + dStr_(d));
  return { ok: true };
}

function voidAttendance(token, id) {
  const u = authUser_(token, false);
  if (!canRecordAttendance_(u)) throw new Error('ไม่มีสิทธิ์');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const rec = findRow_('Attendance', id);
    if (!rec || rec.obj.status !== 'ACTIVE') return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
    setFields_(rec, { status: 'VOID', voidedBy: u.name, voidedAt: new Date() });
    log_(u.id, 'ATT_VOID', String(rec.obj.staffId) + ':' + rec.obj.type + ':' + dStr_(rec.obj.date));
    return { ok: true };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}

// ---------- ที่อยู่อาศัย ----------

function houseInfo_() {
  const act = {};
  activeTeachers_().forEach(x => act[norm_(x.userId)] = String(x.name));
  const occ = {};
  readSheet_('Addresses').forEach(r => { if (r.type === 'ON' && r.houseNo && act[norm_(r.staffId)]) (occ[String(r.houseNo)] = occ[String(r.houseNo)] || []).push(act[norm_(r.staffId)]); });
  return readSheet_('Houses').map(r => String(r.houseNo || '').trim()).filter(Boolean).map(hn => ({ houseNo: hn, occupants: occ[hn] || [] }));
}
function addrOut_(r) {
  r = r || {};
  const s = k => String(r[k] === undefined || r[k] === null ? '' : r[k]);
  return { type: s('type'), houseNo: s('houseNo'), addressText: s('addressText'), landlord: s('landlord'), phone: s('phone') };
}

/** ภาพรวมที่อยู่ของครูทุกคน */
function getAddresses(token) {
  const u = authUser_(token, false);
  if (!canViewStaff_(u)) throw new Error('ไม่มีสิทธิ์');
  const byId = {}; readSheet_('Addresses').forEach(r => byId[norm_(r.staffId)] = r);
  const docs = new Set(readSheet_('Documents').filter(r => r.kind === 'HOUSE' && r.status === 'ACTIVE').map(r => norm_(r.staffId)));
  return { rows: activeTeachers_().map(x => Object.assign({ staffId: String(x.userId), name: String(x.name), hasDoc: docs.has(norm_(x.userId)) }, addrOut_(byId[norm_(x.userId)]))), houses: houseInfo_() };
}
function getAddress(token, staffId) {
  const u = authUser_(token, false);
  if (!canViewStaff_(u)) throw new Error('ไม่มีสิทธิ์');
  const t = teacherUser_(staffId);
  if (!t) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
  const r = readSheet_('Addresses').find(x => norm_(x.staffId) === norm_(staffId));
  return { ok: true, address: addrOut_(r), houses: houseInfo_(), canEdit: canEditStaff_(u) && isActive_(t) };
}
function saveAddress(token, item) {
  const u = authUser_(token, false);
  if (!canEditStaff_(u)) throw new Error('ไม่มีสิทธิ์แก้ไข');
  item = item || {};
  const t = activeTeachers_().find(x => norm_(x.userId) === norm_(item.staffId));
  if (!t) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
  const type = String(item.type || '');
  if (['', 'ON', 'OFF'].indexOf(type) < 0) return { ok: false, code: 'TYPE_BAD', message: 'ประเภทไม่ถูกต้อง' };
  const f = { staffId: String(t.userId), type: type, houseNo: '', addressText: '', landlord: clean_(item.landlord, 150), phone: clean_(item.phone, 50), updatedBy: u.name, updatedAt: new Date() };
  if (type === 'ON') {
    f.houseNo = clean_(item.houseNo, 50);
    if (!f.houseNo) return { ok: false, code: 'HOUSE_REQ', message: 'กรุณาเลือกบ้านพัก' };
    const list = houseInfo_();
    if (list.length && !list.some(x => x.houseNo === f.houseNo)) return { ok: false, code: 'HOUSE_BAD', message: 'บ้านพักนี้ไม่อยู่ในรายการ' };
  }
  if (type === 'OFF') {
    f.addressText = clean_(item.addressText, 500);
    if (!f.addressText) return { ok: false, code: 'ADDR_REQ', message: 'กรุณากรอกที่อยู่' };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const rec = findRow_('Addresses', String(t.userId), 'staffId');
    if (rec) setFields_(rec, f); else appendByHeader_('Addresses', f);
    log_(u.id, 'ADDR_SAVE', String(t.userId)); // ไม่จดที่อยู่ลง Log
    return { ok: true };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}

// ---------- ออก-เข้าประเทศ + ลงที่พัก (ตม.30) ----------

function tripOut_(r) {
  const back = r.returnDate instanceof Date ? r.returnDate : null;
  return { id: String(r.id), staffId: String(r.staffId), exitDate: dStr_(r.exitDate), returnDate: dStr_(r.returnDate), note: String(r.note || ''),
    tm30Done: isTrue_(r.tm30Done), tm30Date: dStr_(r.tm30Date), pending: !!back && back.getTime() <= Date.now() && !isTrue_(r.tm30Done) };
}
function listTrips(token, staffId) {
  const u = authUser_(token, false);
  if (!canViewStaff_(u)) throw new Error('ไม่มีสิทธิ์');
  const t = teacherUser_(staffId);
  const trips = readSheet_('Travel').filter(r => r.status === 'ACTIVE' && norm_(r.staffId) === norm_(staffId)).map(tripOut_)
    .sort((a, b) => a.exitDate < b.exitDate ? 1 : a.exitDate > b.exitDate ? -1 : 0);
  return { trips: trips, canEdit: canEditStaff_(u) && !!t && isActive_(t) };
}
function saveTrip(token, item) {
  const u = authUser_(token, false);
  if (!canEditStaff_(u)) throw new Error('ไม่มีสิทธิ์แก้ไข');
  item = item || {};
  const t = activeTeachers_().find(x => norm_(x.userId) === norm_(item.staffId));
  if (!t) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
  const ex = toDate_(item.exitDate), back = toDate_(item.returnDate);
  if (ex === '') return { ok: false, code: 'EXIT_REQ', message: 'กรุณาระบุวันออกนอกประเทศ' };
  if (ex === null || back === null) return { ok: false, code: 'DATE_BAD', message: 'รูปแบบวันที่ไม่ถูกต้อง' };
  if (back !== '' && back.getTime() < ex.getTime()) return { ok: false, code: 'RANGE_BAD', message: 'วันกลับต้องไม่ก่อนวันออก' };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const f = { exitDate: ex, returnDate: back, note: clean_(item.note, 300) };
    if (item.id) {
      const rec = findRow_('Travel', item.id);
      if (!rec || rec.obj.status !== 'ACTIVE' || norm_(rec.obj.staffId) !== norm_(t.userId)) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
      if (back === '') { f.tm30Done = false; f.tm30Date = ''; } // ยังไม่กลับ -> ยังไม่มีเรื่องลงที่พัก
      setFields_(rec, f);
      log_(u.id, 'TRIP_SAVE', String(t.userId));
      return { ok: true, id: String(item.id) };
    }
    const id = 'T' + uid8_();
    appendByHeader_('Travel', Object.assign({ id: id, staffId: String(t.userId), tm30Done: false, status: 'ACTIVE', recordedBy: u.name, recordedAt: new Date() }, f));
    log_(u.id, 'TRIP_SAVE', String(t.userId));
    return { ok: true, id: id };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}
function markTm30(token, tripId, date) {
  const u = authUser_(token, false);
  if (!canEditStaff_(u)) throw new Error('ไม่มีสิทธิ์แก้ไข');
  const d = toDate_(date === undefined || date === null || String(date).trim() === '' ? todayStr_() : date);
  if (d === null || d === '') return { ok: false, code: 'DATE_BAD', message: 'รูปแบบวันที่ไม่ถูกต้อง' };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const rec = findRow_('Travel', tripId);
    if (!rec || rec.obj.status !== 'ACTIVE') return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
    if (!(rec.obj.returnDate instanceof Date)) return { ok: false, code: 'NEED_RETURN', message: 'ต้องบันทึกวันกลับเข้าประเทศก่อน' };
    setFields_(rec, { tm30Done: true, tm30Date: d });
    log_(u.id, 'TM30_DONE', String(rec.obj.staffId));
    return { ok: true };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}
function voidTrip(token, tripId) {
  const u = authUser_(token, false);
  if (!canEditStaff_(u)) throw new Error('ไม่มีสิทธิ์แก้ไข');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const rec = findRow_('Travel', tripId);
    if (!rec || rec.obj.status !== 'ACTIVE') return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
    setFields_(rec, { status: 'VOID' });
    log_(u.id, 'TRIP_VOID', String(rec.obj.staffId));
    return { ok: true };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}
