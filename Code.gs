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
  MasterPlans: COMMON.concat(['plan', 'pdfFileId']), // plan = ข้อมูลแผนหน้าเดียว (JSON) ; pdfFileId = PDF ของสัปดาห์นั้น
  // เล่มแผนที่อนุมัติแล้ว ต่อ ครู + ภาคเรียน + วิชา + ห้อง (เก็บล่าสุดหนึ่งไฟล์)
  PlanBooks:   ['key', 'teacherId', 'teacherName', 'term', 'subject', 'class', 'program', 'fileId', 'weeks', 'updatedAt'],
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
  // ตารางสอนรวมของครูทุกคน: ใส่ teacherId ในคอลัมน์นี้ให้ตรงกับ userId ของครู (ครูจะเห็นเฉพาะแถวของตัวเอง)
  Timetable:   ['teacherId', 'teacherName', 'totalPeriods', 'schedule', 'updatedAt'],
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
  seedTimetable_();
  archiveFolder_(); // สร้างโฟลเดอร์ Drive ส่วนตัวสำหรับไฟล์สแกน (ครั้งแรกจะขอสิทธิ์ใช้ Drive)
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PEPPER')) props.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  const users = ss.getSheetByName('Users');
  if (users.getLastRow() === 1) {
    users.getRange(2, 1, 5, 9).setValues([
      ['head01',    'คุณฉัตรชัย', 'chartchai.ma@rvs.ac.th', 'HEAD',    '',         true, '', '', ''],
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
    .addItem('ตั้งค่า API key สำหรับอ่านเอกสารอัตโนมัติ', 'setAiKeyFromMenu')
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
    appendByHeader_(category, row);
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
    if (rec.obj.plan) {
      const p = parsePlan_(rec.obj.plan);
      if (!p.term || !p.subject || !p.class || !p.lo || !p.steps) return { ok: false, code: 'PLAN_REQ', message: 'กรอกช่องที่จำเป็นของแผนให้ครบก่อนส่งตรวจ' };
    } else if (!rec.obj.fileUrl) return { ok: false, code: 'LINK_REQ', message: 'กรุณาแนบลิงก์ไฟล์ก่อนส่งตรวจ' };
    const now = new Date();
    setFields_(rec, { status: 'SUBMITTED', submittedAt: now, updatedAt: now });
    if (category === 'MasterPlans' && rec.obj.plan) {
      const old = rec.obj.pdfFileId;
      try {
        const fid = makeWeekPdf_(rec.obj.plan, rec.obj.teacherId);
        setFields_(rec, { pdfFileId: fid });
        if (old) moveToArchive_(String(old));
      } catch (e) { console.error('สร้าง PDF รายสัปดาห์ไม่สำเร็จ: ' + e.message); }
    }
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
    if (category === 'MasterPlans' && decision === 'APPROVED') {
      try { rebuildBook_(rec.obj.teacherId, rec.obj.term, rec.obj.subject, rec.obj['class']); }
      catch (e) { console.error('รวมเล่มแผนไม่สำเร็จ: ' + e.message); }
    }
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
    if (rec.obj.returnDate.getTime() > Date.now()) return { ok: false, code: 'NOT_BACK', message: 'ยังไม่ถึงวันกลับเข้าประเทศ' }; // ลงที่พักได้หลังกลับถึงแล้วเท่านั้น
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


// ================= แจ้งเตือนของครูต่างชาติ (แผงขวา) =================
/** เฉพาะของตัวเอง: งานที่ถูกตีกลับ + เอกสารตัวเองที่ใกล้หมดอายุ */
function getTeacherAlerts(token) {
  const u = authUser_(token, false);
  if (u.role !== 'TEACHER') throw new Error('ไม่มีสิทธิ์');
  const alerts = [];
  Object.keys(ACADEMIC).forEach(k => readSheet_(k).forEach(r => {
    if (norm_(r.teacherId) === u.id && r.status === 'RETURNED')
      alerts.push({ kind: 'returned', category: k, name: String(r.title || ''), date: dStr_(r.reviewedAt), days: null, level: 'bad' });
  }));
  const s = readSheet_('Staff').find(r => norm_(r.staffId) === u.id);
  if (s) {
    [['workPermitExpiry', EXPIRY_DAYS], ['contractEnd', EXPIRY_DAYS], ['visaExpiry', EXPIRY_DAYS], ['passportExpiry', PASSPORT_DAYS]].forEach(k => {
      const d = s[k[0]];
      if (!(d instanceof Date)) return;
      const days = daysTo_(d);
      if (days <= k[1]) alerts.push({ kind: k[0], name: u.name, date: dStr_(d), days: days, level: days <= 30 ? 'bad' : 'warn' });
    });
  }
  alerts.sort((a, b) => (a.days === null ? -1 : b.days === null ? 1 : a.days - b.days));
  return { alerts: alerts };
}

// ================= แผนการจัดการเรียนรู้ (กรอกในระบบ) =================
const PLAN_TEXT = ['week', 'dateRange', 'term', 'subject', 'class', 'program'];
const PLAN_LONG = ['lo', 'synopsis', 'methods', 'media', 'leadIn', 'steps', 'wrapUp', 'evaluation'];

function cleanPlan_(p) {
  p = p || {};
  const o = {};
  PLAN_TEXT.forEach(k => o[k] = clean_(p[k], 150));
  PLAN_LONG.forEach(k => o[k] = clean_(p[k], 3000));
  o.assessments = (Array.isArray(p.assessments) ? p.assessments : []).slice(0, 6).map(r => ({
    method: clean_(r && r.method, 300), tool: clean_(r && r.tool, 300), criteria: clean_(r && r.criteria, 300) }));
  return o;
}
function parsePlan_(raw) { try { return JSON.parse(String(raw || '{}')); } catch (e) { return {}; } }

/** บันทึกร่าง (ไม่บังคับช่อง) */
function savePlanDraft(token, id, plan) {
  const u = authUser_(token, false);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const rec = ownDraft_(u, 'MasterPlans', id);
    if (!rec) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
    if (rec.obj.status !== 'DRAFT' && rec.obj.status !== 'RETURNED') return { ok: false, code: 'CANT_EDIT', message: 'แก้ไขไม่ได้ในสถานะนี้' };
    const p = cleanPlan_(plan), json = JSON.stringify(p);
    if (json.length > 40000) return { ok: false, code: 'PLAN_BIG', message: 'เนื้อหาแผนยาวเกินไป' };
    const now = new Date();
    setFields_(rec, { plan: json, term: p.term, subject: p.subject, class: p['class'], title: (p.lo || 'แผนการจัดการเรียนรู้').slice(0, 200), status: 'DRAFT', updatedAt: now });
    log_(u.id, 'PLAN_SAVE', String(id));
    return { ok: true, id: String(id) };
  } finally { if (lock.hasLock()) lock.releaseLock(); }
}

/** ดูแผน: เจ้าของหรือผู้ตรวจ */
function getLessonPlan(token, id) {
  const u = authUser_(token, false);
  const rec = findRow_('MasterPlans', id);
  if (!rec) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
  if (!(norm_(rec.obj.teacherId) === u.id || isReviewer_(u))) throw new Error('ไม่มีสิทธิ์');
  return { ok: true, plan: parsePlan_(rec.obj.plan) };
}

// ================= ตารางสอนรวม (ดูได้ตามสิทธิ์) =================
const TT_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const TT_TIMES = ["08:20-09:10", "09:10-10.00", "10:20-11.10", "11.10-12.00", "(12.00-12.50)", "12.50-13.40", "13.40.14.30", "14.50-15.40"];
const TT_PERIODS = ["Per.1", "Per.2", "Per.3", "Per.4", "P4:12", "Per.5", "Per.6", "Per.7"];
const TT_SEED = [
 {
  "name": "Miss Joyce Cabibil",
  "total": 20,
  "days": {
   "Monday": [
    "",
    "",
    "P2/1",
    "",
    "",
    "P2/2",
    "P3/1",
    ""
   ],
   "Tuesday": [
    "P2/3",
    "",
    "P3/3",
    "",
    "P3/5",
    "",
    "P2/5",
    "P1/1"
   ],
   "Wednesday": [
    "",
    "",
    "P1/2",
    "",
    "P2/2",
    "P1/1",
    "",
    "P3/2"
   ],
   "Thursday": [
    "P2/5",
    "",
    "P3/5",
    "",
    "P2/1",
    "",
    "",
    "P2/3"
   ],
   "Friday": [
    "P1/2",
    "P3/1",
    "P3/2",
    "",
    "",
    "P3/3",
    "",
    ""
   ]
  }
 },
 {
  "name": "Mr. Samuel Htet",
  "total": 19,
  "days": {
   "Monday": [
    "",
    "",
    "P6/6",
    "",
    "P2/5",
    "P3/5",
    "",
    "P4/5"
   ],
   "Tuesday": [
    "",
    "M3/5",
    "M2/5",
    "P5/6",
    "",
    "M1/4",
    "",
    ""
   ],
   "Wednesday": [
    "",
    "P4/5",
    "P5/6",
    "",
    "",
    "",
    "",
    ""
   ],
   "Thursday": [
    "P6/6",
    "",
    "",
    "P4/5",
    "",
    "P3/5",
    "P5/6",
    "P2/5"
   ],
   "Friday": [
    "",
    "P6/6",
    "P4/5",
    "P5/6",
    "",
    "",
    "P6/6",
    ""
   ]
  }
 },
 {
  "name": "Miss Florentina Montemayor",
  "total": 19,
  "days": {
   "Monday": [
    "",
    "M2/5",
    "M3/5",
    "",
    "",
    "M1/2",
    "M1/3",
    ""
   ],
   "Tuesday": [
    "M2/5",
    "M1/2",
    "P6/4",
    "",
    "",
    "",
    "",
    ""
   ],
   "Wednesday": [
    "",
    "M1/3",
    "M1/4",
    "M3/5",
    "",
    "",
    "",
    "P6/4"
   ],
   "Thursday": [
    "",
    "M1/4",
    "SMR",
    "M2/5",
    "",
    "",
    "M1/1",
    ""
   ],
   "Friday": [
    "M3/5",
    "M1/1",
    "",
    "SMR",
    "",
    "",
    "M1/4",
    ""
   ]
  }
 },
 {
  "name": "Miss Marie Joyce",
  "total": 20,
  "days": {
   "Monday": [
    "",
    "",
    "P6/3",
    "P5/4",
    "",
    "",
    "P6/2",
    "P4/3"
   ],
   "Tuesday": [
    "",
    "P4/1",
    "P4/2",
    "P6/3",
    "",
    "P5/4",
    "P4/3",
    ""
   ],
   "Wednesday": [
    "P5/1",
    "",
    "P6/1",
    "",
    "",
    "P4/2",
    "",
    ""
   ],
   "Thursday": [
    "",
    "P5/2",
    "",
    "P5/1",
    "",
    "P6/2",
    "",
    "P5/3"
   ],
   "Friday": [
    "",
    "",
    "P5/3",
    "",
    "",
    "P6/1",
    "P4/1",
    "P5/2"
   ]
  }
 },
 {
  "name": "Miss Maria Luz",
  "total": 20,
  "days": {
   "Monday": [
    "",
    "P1/6",
    "P1/5",
    "",
    "",
    "M1/4",
    "M2/5",
    ""
   ],
   "Tuesday": [
    "P2/5",
    "",
    "P4/5",
    "P6/6",
    "",
    "",
    "",
    ""
   ],
   "Wednesday": [
    "M1/4",
    "M2/5",
    "",
    "",
    "P3/5",
    "",
    "",
    "P4/5"
   ],
   "Thursday": [
    "P1/6",
    "P1/5",
    "",
    "",
    "",
    "P6/6",
    "M3/5",
    "P5/6"
   ],
   "Friday": [
    "P3/5",
    "P2/5",
    "",
    "M3/5",
    "",
    "P5/6",
    "",
    ""
   ]
  }
 },
 {
  "name": "Mr. Nadir  Ilhan",
  "total": 19,
  "days": {
   "Monday": [
    "",
    "P5/5",
    "P2/4",
    "",
    "P1/4",
    "P3/4",
    "",
    ""
   ],
   "Tuesday": [
    "P1/4",
    "",
    "SMR",
    "",
    "P1/3",
    "",
    "P5/5",
    "P6/5"
   ],
   "Wednesday": [
    "",
    "P4/4",
    "",
    "SMR",
    "",
    "",
    "",
    "P1/3"
   ],
   "Thursday": [
    "P1/4",
    "",
    "",
    "P4/4",
    "",
    "P6/5",
    "",
    ""
   ],
   "Friday": [
    "P1/3",
    "",
    "P6/5",
    "",
    "",
    "P5/5",
    "P4/4",
    ""
   ]
  }
 },
 {
  "name": "Mr. Rodrigo Balsini",
  "total": 19,
  "days": {
   "Monday": [
    "",
    "P1/3",
    "",
    "SMR",
    "",
    "",
    "P4/4",
    ""
   ],
   "Tuesday": [
    "P3/4",
    "P1/4",
    "",
    "",
    "",
    "",
    "P6/5",
    ""
   ],
   "Wednesday": [
    "P2/4",
    "P5/5",
    "SMR",
    "",
    "",
    "P3/4",
    "",
    ""
   ],
   "Thursday": [
    "P5/5",
    "P6/5",
    "P1/4",
    "",
    "P1/3",
    "",
    "",
    "P4/4"
   ],
   "Friday": [
    "",
    "P3/4",
    "SMR",
    "",
    "P2/4",
    "P3/4",
    "",
    ""
   ]
  }
 },
 {
  "name": "Mr. Julien Belda",
  "total": 19,
  "days": {
   "Monday": [
    "",
    "P2/4",
    "SMR",
    "",
    "",
    "",
    "",
    ""
   ],
   "Tuesday": [
    "P2/4",
    "P3/4",
    "",
    "SMR",
    "",
    "P1/3",
    "",
    ""
   ],
   "Wednesday": [
    "",
    "P6/5",
    "P2/4",
    "",
    "P1/4",
    "",
    "P4/4",
    ""
   ],
   "Thursday": [
    "P1/3",
    "P3/4",
    "P4/4",
    "SMR",
    "",
    "",
    "",
    "P5/5"
   ],
   "Friday": [
    "P1/4",
    "P2/4",
    "P5/5",
    "",
    "",
    "",
    "P6/5",
    ""
   ]
  }
 },
 {
  "name": "Mrs. Aiza Dela cruz Alconcel",
  "total": null,
  "days": {
   "Monday": [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    ""
   ],
   "Tuesday": [
    "",
    "",
    "",
    "",
    "",
    "",
    "P1/6",
    ""
   ],
   "Wednesday": [
    "",
    "",
    "",
    "",
    "",
    "",
    "P1/5",
    ""
   ],
   "Thursday": [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    ""
   ],
   "Friday": [
    "",
    "",
    "",
    "",
    "P1/5",
    "P1/6",
    "",
    ""
   ]
  }
 },
 {
  "name": "Miss Mirafy Balang",
  "total": null,
  "days": {
   "Monday": [
    "",
    "",
    "",
    "",
    "",
    "",
    "P1/6",
    ""
   ],
   "Tuesday": [
    "",
    "",
    "",
    "",
    "",
    "",
    "P1/5",
    ""
   ],
   "Wednesday": [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "P1/6"
   ],
   "Thursday": [
    "",
    "",
    "",
    "",
    "",
    "P1/5",
    "",
    ""
   ],
   "Friday": [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    ""
   ]
  }
 },
 {
  "name": "Mr. Chartchai (Master thee)",
  "total": null,
  "days": {
   "Monday": [
    "",
    "",
    "M4/1",
    "M4/1",
    "",
    "M4/2",
    "M4/2",
    ""
   ],
   "Tuesday": [
    "",
    "",
    "M4/3",
    "M4/3",
    "",
    "",
    "",
    ""
   ],
   "Wednesday": [
    "",
    "",
    "M4/3",
    "M4/3",
    "",
    "M6/2",
    "M6/2",
    ""
   ],
   "Thursday": [
    "M6/1",
    "M6/1",
    "M4/3",
    "",
    "",
    "",
    "",
    ""
   ],
   "Friday": [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    ""
   ]
  }
 }
];

/** ครั้งแรกที่ยังไม่มีแถว ให้ใส่ตารางจากไฟล์ Schedule of all2026 (teacherId ว่างไว้ให้ผู้ดูแลกรอก) */
function seedTimetable_() {
  const sh = SpreadsheetApp.getActive().getSheetByName('Timetable');
  if (!sh || sh.getLastRow() > 1) return;
  TT_SEED.forEach(x => appendByHeader_('Timetable', { teacherId: '', teacherName: x.name, totalPeriods: x.total === null ? '' : x.total,
    schedule: JSON.stringify({ days: x.days }), updatedAt: new Date() }));
}

/** ครู (ระดับ 1): เห็นเฉพาะแถวของตัวเอง · ระดับ 2–5: เห็นทุกคน */
function listTimetable(token) {
  const u = authUser_(token, false);
  const rows = readSheet_('Timetable').filter(r => String(r.teacherName || '').trim() !== '')
    .filter(r => u.role !== 'TEACHER' || norm_(r.teacherId) === u.id)
    .map(r => {
      let days = {};
      try { days = (JSON.parse(String(r.schedule || '{}')).days) || {}; } catch (e) { days = {}; }
      let n = 0; TT_DAYS.forEach(d => (days[d] || []).forEach(v => { if (String(v || '').trim()) n++; }));
      return { teacherId: String(r.teacherId || ''), teacherName: String(r.teacherName), total: r.totalPeriods === '' ? n : Number(r.totalPeriods) || n,
        days: days, mine: norm_(r.teacherId) === u.id };
    });
  return { rows: rows, days: TT_DAYS, times: TT_TIMES, periods: TT_PERIODS };
}

// ================= PDF แผนการสอน (ภาษาอังกฤษ) และเล่มแผนที่อนุมัติแล้ว =================
const SCHOOL_NAME = 'Rung Aroon Vitthaya School';
const SCHOOL_LOGO_B64 = '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';
const PDF_CSS = "@page{size:A4;margin:16mm 14mm}body{font-family:Arial,sans-serif;font-size:11pt;color:#000}" +
  ".cover{text-align:center;padding-top:26mm;min-height:250mm;position:relative}" +
  ".cover img{width:3.5cm;height:3.5cm}.cover h1{font-size:22pt;margin:8mm 0 6mm}.cover .f{font-size:14pt;margin:3mm 0}" +
  ".cover .school{position:absolute;bottom:0;left:0;right:0;font-size:16pt;font-weight:bold}" +
  ".page{page-break-before:always}.page h2{font-size:15pt;border-bottom:2px solid #000;padding-bottom:2mm}" +
  "h3{font-size:12pt;margin:6mm 0 2mm}table{width:100%;border-collapse:collapse;margin-top:3mm}" +
  "td,th{border:1px solid #555;padding:3px 6px;vertical-align:top}th{background:#eee;text-align:left}p{margin:1mm 0}";

function esc_(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])).replace(/\n/g, '<br>');
}
function pdfDoc_(body) { return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + PDF_CSS + '</style></head><body>' + body + '</body></html>'; }
function safeName_(s) { return String(s || '').replace(/[\\\/:*?"<>|#%]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120); }
function planSub_(name) { const root = filesFolder_(), it = root.getFoldersByName(name); return it.hasNext() ? it.next() : root.createFolder(name); }
function teacherName_(id) { const u = readSheet_('Users').find(x => norm_(x.userId) === norm_(id)); return u ? String(u.name) : String(id); }

function coverHtml_(p, teacher) {
  return '<div class="cover"><img src="data:image/png;base64,' + SCHOOL_LOGO_B64 + '">' +
    '<h1>' + esc_(p.subject) + '</h1>' +
    '<div class="f">' + esc_(p['class']) + (p.program ? ' · ' + esc_(p.program) : '') + '</div>' +
    '<div class="f">Teacher: ' + esc_(teacher) + '</div>' +
    '<div class="f">Semester / Academic Year: ' + esc_(p.term) + '</div>' +
    '<h1 style="margin-top:12mm">Lesson Plan Book</h1>' +
    '<div class="school">' + SCHOOL_NAME + '</div></div>';
}
function weekHtml_(p, teacher) {
  const row = (a, b) => '<tr><th style="width:30%">' + a + '</th><td>' + esc_(b) + '</td></tr>';
  const sec = (t, b) => '<h3>' + t + '</h3><p>' + esc_(b) + '</p>';
  const ass = (p.assessments || []).map(a => '<tr><td>' + esc_(a.method) + '</td><td>' + esc_(a.tool) + '</td><td>' + esc_(a.criteria) + '</td></tr>').join('') ||
    '<tr><td colspan="3">&nbsp;</td></tr>';
  return '<div class="page"><h2>Lesson Plan · Week ' + esc_(p.week) + '</h2><table>' +
    row('Week', p.week) + row('Date', p.dateRange) + row('Subject', p.subject) + row('Class', p['class']) +
    row('Program', p.program) + row('Teacher', teacher) + row('Semester / Academic Year', p.term) + '</table>' +
    sec('L/O or Topic', p.lo) + sec('Synopsis', p.synopsis) + sec('Teaching Method(s)', p.methods) + sec('Instructional Media(s)', p.media) +
    '<h3>Assessment</h3><table><tr><th>Method</th><th>Tool</th><th>Criteria</th></tr>' + ass + '</table>' +
    sec('Lead in', p.leadIn) + sec('Teaching Steps', p.steps) + sec('Wrap up', p.wrapUp) + sec('Evaluation after class', p.evaluation) + '</div>';
}

/** PDF รายสัปดาห์ (สร้างตอนครูส่งแผน เก็บรอไว้ในโฟลเดอร์ส่วนตัว) */
function makeWeekPdf_(planRaw, teacherId) {
  const p = parsePlan_(planRaw), teacher = teacherName_(teacherId);
  const name = safeName_(teacher + ' - ' + p.subject + ' - ' + p['class'] + ' - Week ' + p.week + ' - ' + p.term) + '.pdf';
  const blob = HtmlService.createHtmlOutput(pdfDoc_(weekHtml_(p, teacher))).getAs('application/pdf');
  blob.setName(name);
  return planSub_('Weeks').createFile(blob).getId();
}

/** เล่มแผน: หน้าปก + สัปดาห์ที่อนุมัติแล้วเรียงตามเลขสัปดาห์ (ทำใหม่ทุกครั้งที่มีการอนุมัติ) */
function rebuildBook_(teacherId, term, subject, cls) {
  const key = [norm_(teacherId), String(term || '').trim(), String(subject || '').trim(), String(cls || '').trim()].join('|');
  const rows = readSheet_('MasterPlans').filter(r => r.status === 'APPROVED' && r.plan &&
      [norm_(r.teacherId), String(r.term || '').trim(), String(r.subject || '').trim(), String(r['class'] || '').trim()].join('|') === key)
    .map(r => ({ p: parsePlan_(r.plan) }))
    .sort((a, b) => (parseInt(a.p.week, 10) || 0) - (parseInt(b.p.week, 10) || 0));
  if (!rows.length) return;
  const teacher = teacherName_(teacherId);
  const body = coverHtml_(rows[0].p, teacher) + rows.map(x => weekHtml_(x.p, teacher)).join('');
  const name = safeName_(teacher + ' - ' + subject + ' - ' + cls + ' - ' + term) + ' (Lesson Plan Book).pdf';
  const blob = HtmlService.createHtmlOutput(pdfDoc_(body)).getAs('application/pdf');
  blob.setName(name);
  const fid = planSub_('Books').createFile(blob).getId();
  const vals = { key: key, teacherId: String(teacherId), teacherName: teacher, term: String(term || ''), subject: String(subject || ''),
    class: String(cls || ''), program: rows[0].p.program || '', fileId: fid, weeks: rows.map(x => x.p.week).join(','), updatedAt: new Date() };
  const pb = findRow_('PlanBooks', key, 'key');
  if (pb) { if (pb.obj.fileId) moveToArchive_(String(pb.obj.fileId)); setFields_(pb, vals); }
  else appendByHeader_('PlanBooks', vals);
}

/** รายการเล่มแผน (ผู้ตรวจเท่านั้น) */
function getPlanBooks(token) {
  const u = authUser_(token, false);
  if (!isReviewer_(u)) throw new Error('ไม่มีสิทธิ์');
  return readSheet_('PlanBooks').map(r => ({ key: String(r.key), teacherName: String(r.teacherName), subject: String(r.subject),
    class: String(r['class']), term: String(r.term), weeks: String(r.weeks), fileId: String(r.fileId), updatedAt: fmtDT_(r.updatedAt) }))
    .sort((a, b) => a.teacherName < b.teacherName ? -1 : a.teacherName > b.teacherName ? 1 : 0);
}
/** ดาวน์โหลดเล่มแผน (ตรวจว่าไฟล์อยู่ในรายการเล่มแผนก่อนเสมอ) */
function getPlanBookFile(token, fileId) {
  const u = authUser_(token, false);
  if (!isReviewer_(u)) throw new Error('ไม่มีสิทธิ์');
  if (!readSheet_('PlanBooks').some(r => String(r.fileId) === String(fileId))) return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบรายการนี้' };
  let f;
  try { f = DriveApp.getFileById(String(fileId)); } catch (e) { return { ok: false, code: 'NOT_FOUND', message: 'ไม่พบไฟล์ใน Drive' }; }
  log_(u.id, 'PLAN_BOOK_VIEW', String(fileId));
  return { ok: true, name: f.getName(), b64: Utilities.base64Encode(f.getBlob().getBytes()) };
}

// ================= อ่านข้อมูลจากไฟล์อัตโนมัติ (Smart Filling, เสริม) =================
// ไฟล์ถูกส่งไปอ่านเพียงครั้งเดียวเพื่อดึงตัวเลขที่ต้องกรอก ระบบไม่บันทึกไฟล์นั้นที่บริการ AI
// ค่าที่อ่านได้เป็นเพียง "ข้อเสนอ" ต้องตรวจทานก่อนกดบันทึกเสมอ ถ้าไม่ตั้งค่า API key ระบบจะกรอกด้วยมือเหมือนเดิม
const AI_MODEL = 'claude-sonnet-5-5';
const AI_KEY_PROP = 'ANTHROPIC_API_KEY';
const SMART_PROMPTS = {
  PASSPORT: 'This is a passport, possibly bilingual. Return ONLY a JSON object with keys: "docNo" (passport number), "expiry" (date of expiry as YYYY-MM-DD), "dob" (date of birth as YYYY-MM-DD). Use null for anything you cannot read clearly. No other text.',
  VISA: 'This is a Thai non-immigrant visa or immigration document. Return ONLY a JSON object with keys: "docNo" (visa number), "docType" (visa category as written), "expiry" (YYYY-MM-DD). Use null when unclear. No other text.',
  WP: 'This is a Thai work permit (ใบอนุญาตทำงาน). Return ONLY a JSON object with keys: "docNo" (work permit number), "expiry" (YYYY-MM-DD). Use null when unclear. No other text.'
};
function aiKey_() { return PropertiesService.getScriptProperties().getProperty(AI_KEY_PROP) || ''; }

/** ผู้ดูแลตั้งค่า key ผ่านเมนู (เก็บใน Script Properties ไม่อยู่ในชีตและไม่อยู่ในโค้ด) */
function setAiKeyFromMenu() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('ใส่ API key (เก็บในระบบเท่านั้น ไม่แสดงในชีต)', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const k = r.getResponseText().trim();
  if (!k) return;
  PropertiesService.getScriptProperties().setProperty(AI_KEY_PROP, k);
  ui.alert('บันทึกแล้ว');
}

/** คืนค่าที่อ่านได้เป็นข้อเสนอ (ไม่บันทึกอะไรลงระบบ) */
function smartFill(token, kind, b64) {
  const u = authUser_(token, false);
  if (!canEditStaff_(u)) throw new Error('ไม่มีสิทธิ์');
  if (!SMART_PROMPTS[kind]) return { ok: false, code: 'KIND_BAD', message: 'ประเภทเอกสารนี้ไม่รองรับการอ่านอัตโนมัติ' };
  const key = aiKey_();
  if (!key) return { ok: false, code: 'AI_OFF', message: 'ยังไม่ได้เปิดการอ่านอัตโนมัติ กรอกด้วยมือได้เลย' };
  b64 = String(b64 || '');
  if (!b64) return { ok: false, code: 'FILE_NONE', message: 'กรุณาเลือกไฟล์' };
  if (b64.length > Math.ceil(MAX_PDF * 4 / 3) + 8) return { ok: false, code: 'FILE_BIG', message: 'ไฟล์ใหญ่เกินไป' };

  let res;
  try {
    res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify({ model: AI_MODEL, max_tokens: 400, messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
        { type: 'text', text: SMART_PROMPTS[kind] } ] }] })
    });
  } catch (e) { return { ok: false, code: 'AI_FAIL', message: 'เชื่อมต่อบริการอ่านเอกสารไม่ได้ กรอกด้วยมือได้เลย' }; }
  if (res.getResponseCode() !== 200) {
    log_(u.id, 'SMART_FAIL', kind + ':' + res.getResponseCode());
    return { ok: false, code: 'AI_FAIL', message: 'อ่านเอกสารไม่สำเร็จ กรอกด้วยมือได้เลย' };
  }
  let text = '';
  try { text = (JSON.parse(res.getContentText()).content || []).filter(c => c.type === 'text').map(c => c.text).join(''); } catch (e) { text = ''; }
  const m = text.match(/\{[\s\S]*\}/);
  let obj = {};
  try { obj = JSON.parse(m ? m[0] : '{}'); } catch (e) { obj = {}; }
  const out = {};
  ['docNo', 'docType', 'expiry', 'dob'].forEach(k => {
    const v = obj[k];
    if (v === null || v === undefined) return;
    const s = String(v).trim().slice(0, 100);
    if (!s) return;
    if ((k === 'expiry' || k === 'dob') && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return; // วันที่ที่อ่านไม่ได้ในรูปแบบชัดเจนจะไม่ถูกใช้
    out[k] = s;
  });
  log_(u.id, 'SMART_FILL', kind); // ไม่จดค่าที่อ่านได้ลง Log
  return { ok: true, fields: out };
}
