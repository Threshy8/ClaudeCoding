import { useState, useRef, useEffect } from 'react';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftMonths(year, month, delta) {
  let m = month + delta;
  let y = year;
  while (m > 11) { m -= 12; y++; }
  while (m < 0)  { m += 12; y--; }
  return [y, m];
}

function buildPresets() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = toIso(now);
  const pad = (n) => String(n).padStart(2, '0');

  // Monday of this week
  const dayOfWeek = (now.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek);
  const weekStart = toIso(monday);

  const thisMonthStart = `${y}-${pad(m + 1)}-01`;

  const [lastY, lastM] = shiftMonths(y, m, -1);
  const lastMonthStart = `${lastY}-${pad(lastM + 1)}-01`;
  const lastMonthEnd = toIso(new Date(y, m, 0));

  const [l3y, l3m] = shiftMonths(y, m, -2);
  const last3Start = `${l3y}-${pad(l3m + 1)}-01`;

  const thisYearStart = `${y}-01-01`;

  return [
    { label: 'Today',         start: today,          end: today },
    { label: 'This Week',     start: weekStart,      end: today },
    { label: 'This Month',    start: thisMonthStart, end: today },
    { label: 'Last Month',    start: lastMonthStart, end: lastMonthEnd },
    { label: 'Last 3 Months', start: last3Start,     end: lastMonthEnd },
    { label: 'This Year',     start: thisYearStart,  end: today },
  ];
}

function fmtDisplay(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

export function triggerLabel(value) {
  if (value.label && value.label !== 'Custom') return value.label;
  if (!value.start || !value.end) return 'Select range';
  if (value.start === value.end) return fmtDisplay(value.start);
  return `${fmtDisplay(value.start)} – ${fmtDisplay(value.end)}`;
}

// --- Calendar month grid ---
function CalendarMonth({ year, month, selStart, selEnd, hoverDate, onDayClick, onDayHover }) {
  const pad = (n) => String(n).padStart(2, '0');
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // 0 = Monday
  const totalDays = new Date(year, month + 1, 0).getDate();
  const todayIso = toIso(new Date());

  // Build display range: if still selecting (selEnd=null), show hover preview
  const displayEnd = selEnd || hoverDate;
  const lo = selStart && displayEnd
    ? (selStart <= displayEnd ? selStart : displayEnd)
    : selStart;
  const hi = selStart && displayEnd
    ? (selStart <= displayEnd ? displayEnd : selStart)
    : null;

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) {
    cells.push(`${year}-${pad(month + 1)}-${pad(d)}`);
  }

  return (
    <div className="drp-cal">
      <div className="drp-cal-title">{MONTH_NAMES[month]} {year}</div>
      <div className="drp-cal-grid">
        {WEEKDAYS.map((w) => <div key={w} className="drp-cal-wd">{w}</div>)}
        {cells.map((date, i) => {
          if (!date) return <div key={`e${i}`} />;

          const isStart   = date === lo && hi !== null && lo !== hi;
          const isEnd     = date === hi && lo !== null && lo !== hi;
          const isSingle  = date === lo && (hi === null || hi === lo);
          const isInRange = lo && hi && lo !== hi && date > lo && date < hi;
          const isToday   = date === todayIso;

          const cls = [
            'drp-day',
            isSingle  ? 'drp-single'    : '',
            isStart   ? 'drp-range-s'   : '',
            isEnd     ? 'drp-range-e'   : '',
            isInRange ? 'drp-in-range'  : '',
            isToday   ? 'drp-today'     : '',
          ].filter(Boolean).join(' ');

          return (
            <button
              key={date}
              className={cls}
              onClick={() => onDayClick(date)}
              onMouseEnter={() => onDayHover(date)}
              onMouseLeave={() => onDayHover(null)}
            >
              {new Date(date + 'T12:00:00').getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Main component ---
export default function DateRangePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(null);
  const [draftEnd, setDraftEnd]     = useState(null);
  const [hoverDate, setHoverDate]   = useState(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [closing, setClosing] = useState(false);

  const initView = () => {
    const end = value.end || toIso(new Date());
    const d = new Date(end + 'T12:00:00');
    return shiftMonths(d.getFullYear(), d.getMonth(), -1);
  };
  const [[viewYear, viewMonth], setView] = useState(initView);

  const wrapRef = useRef();

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        closeDropdown();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  });

  const closeDropdown = () => {
    if (!open || closing) return;
    setClosing(true);
    setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 150);
  };

  const handleToggle = () => {
    if (open) {
      closeDropdown();
      return;
    }
    setDraftStart(null);
    setDraftEnd(null);
    setHoverDate(null);
    setIsSelecting(false);
    const [vy, vm] = initView();
    setView([vy, vm]);
    setOpen(true);
  };

  const handleDayClick = (date) => {
    if (!isSelecting) {
      setDraftStart(date);
      setDraftEnd(null);
      setIsSelecting(true);
    } else {
      const [s, e] = date >= draftStart ? [draftStart, date] : [date, draftStart];
      setDraftEnd(e);
      setDraftStart(s);
      setIsSelecting(false);
    }
  };

  const handleApply = () => {
    if (draftStart && draftEnd) {
      onChange({ start: draftStart, end: draftEnd, label: 'Custom' });
      closeDropdown();
    }
  };

  const handlePreset = (preset) => {
    onChange({ start: preset.start, end: preset.end, label: preset.label });
    closeDropdown();
  };

  const [rightYear, rightMonth] = shiftMonths(viewYear, viewMonth, 1);
  const presets = buildPresets();

  const calStart = draftStart ?? value.start;
  const calEnd   = draftEnd   ?? (isSelecting ? null : value.end);

  const hasApply = draftStart && draftEnd;
  const hint = isSelecting
    ? `Start: ${fmtDisplay(draftStart)} — pick end date`
    : hasApply
    ? `${fmtDisplay(draftStart)} – ${fmtDisplay(draftEnd)}`
    : null;

  return (
    <div className="drp-wrap" ref={wrapRef}>
      <button className={`drp-trigger${open ? ' drp-open' : ''}`} onClick={handleToggle}>
        <span className="drp-trigger-icon">&#128197;</span>
        <span>{triggerLabel(value)}</span>
        <span className="drp-arrow">&#9662;</span>
      </button>

      {open && (
        <div className={`drp-dropdown${closing ? ' drp-closing' : ''}`}>
          <div className="drp-body">
            {/* Presets */}
            <div className="drp-presets">
              {presets.map((p) => (
                <button
                  key={p.label}
                  className={`drp-preset${value.label === p.label && !draftStart ? ' drp-preset-active' : ''}`}
                  onClick={() => handlePreset(p)}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Calendars */}
            <div className="drp-cals-wrap">
              <div className="drp-cals-nav">
                <button className="drp-nav-btn" onClick={() => setView(shiftMonths(viewYear, viewMonth, -1))}>&#8249;</button>
                <button className="drp-nav-btn" onClick={() => setView(shiftMonths(viewYear, viewMonth, 1))}>&#8250;</button>
              </div>
              <div className="drp-cals">
                <CalendarMonth
                  year={viewYear} month={viewMonth}
                  selStart={calStart} selEnd={calEnd}
                  hoverDate={isSelecting ? hoverDate : null}
                  onDayClick={handleDayClick}
                  onDayHover={setHoverDate}
                />
                <div className="drp-cals-divider" />
                <CalendarMonth
                  year={rightYear} month={rightMonth}
                  selStart={calStart} selEnd={calEnd}
                  hoverDate={isSelecting ? hoverDate : null}
                  onDayClick={handleDayClick}
                  onDayHover={setHoverDate}
                />
              </div>

              <div className="drp-footer">
                <span className="drp-hint">{hint || '\u00a0'}</span>
                <button
                  className="drp-apply-btn"
                  onClick={handleApply}
                  disabled={!hasApply}
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
