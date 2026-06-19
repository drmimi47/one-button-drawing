import { useEffect, useRef, useState } from 'react';
import { fullAssemblyName } from '../../facade/assemblies';
import { FACADE_CATEGORIES } from '../../facade/catalog';
import {
  derivedRValue,
  type AssemblyMetadata,
  type FacadeField,
  type FacadeFieldGroup,
} from '../../facade/metadata';
import styles from './AssemblyInspector.module.css';

interface AssemblyInspectorProps {
  /** The assembly type being inspected (catalog key, e.g. "UCWP"). */
  assembly: string;
  /** The live type-level metadata sheet for this assembly type. */
  meta: AssemblyMetadata;
  /** The field groups to show (glazed vs opaque), from the catalog. */
  fieldGroups: FacadeFieldGroup[];
  /** Which metadata field is the on-canvas band width (mullion or joint). */
  bandField: 'mullionWidthIn' | 'jointWidthIn';
  /** Live interior size of the selected panel, in feet (reflects canvas drags). */
  widthFt: number;
  heightFt: number;
  /** Pick a different facade type for the selected panel. */
  onChangeType: (key: string) => void;
  /** Edit a type-level (non-band) metadata field — applies to the whole assembly type. */
  onChange: (key: keyof AssemblyMetadata, value: string | number) => void;
  /** Edit the band width (inches) — drives the on-canvas band for every panel of this type. */
  onChangeBand: (inches: number) => void;
  /** Edit the selected panel's interior size (feet) — per-panel. */
  onChangeSize: (widthFt: number, heightFt: number) => void;
}

/**
 * Left-docked "smart panel" inspector for Facade mode. Its title is a dropdown that picks the panel's
 * facade type from the catalog (grouped by category). Below it, category-specific data fields plus a
 * live Dimensions group. Size + band edits flow to the canvas (and canvas drags flow back here); other
 * fields edit the type-level metadata, which feeds the AI render prompt.
 */
export function AssemblyInspector({
  assembly,
  meta,
  fieldGroups,
  bandField,
  widthFt,
  heightFt,
  onChangeType,
  onChange,
  onChangeBand,
  onChangeSize,
}: AssemblyInspectorProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);

  // Close the type menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <aside className={styles.panel} aria-label="Panel assembly">
      <div className={styles.header} ref={headerRef}>
        <button
          type="button"
          className={styles.titleButton}
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span className={styles.title}>{fullAssemblyName(assembly)}</span>
          <svg className={styles.chevron} width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M6 9l6 6 6-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className={styles.badge}>{assembly}</span>

        {menuOpen && (
          <div className={styles.menu} role="listbox">
            {FACADE_CATEGORIES.map((cat) => (
              <div key={cat.title} className={styles.menuGroup}>
                <div className={styles.menuGroupTitle}>{cat.title}</div>
                {cat.types.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="option"
                    aria-selected={t.key === assembly}
                    className={`${styles.menuItem} ${t.key === assembly ? styles.menuItemActive : ''}`}
                    onClick={() => {
                      onChangeType(t.key);
                      setMenuOpen(false);
                    }}
                  >
                    <span>{t.label}</span>
                    {t.key === assembly && <span className={styles.check}>✓</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.body}>
        {/* Per-panel dimensions (reflect live canvas drags). */}
        <section className={styles.group}>
          <h3 className={styles.groupTitle}>Dimensions</h3>
          <div className={styles.row}>
            <span className={styles.label}>Width</span>
            <span className={styles.numberWrap}>
              <input
                className={`${styles.control} ${styles.number}`}
                type="number"
                step={0.5}
                min={0.5}
                value={round1(widthFt)}
                onChange={(e) => onChangeSize(Math.max(0.5, Number(e.target.value) || 0), heightFt)}
              />
              <span className={styles.unit}>ft</span>
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Height</span>
            <span className={styles.numberWrap}>
              <input
                className={`${styles.control} ${styles.number}`}
                type="number"
                step={0.5}
                min={0.5}
                value={round1(heightFt)}
                onChange={(e) => onChangeSize(widthFt, Math.max(0.5, Number(e.target.value) || 0))}
              />
              <span className={styles.unit}>ft</span>
            </span>
          </div>
        </section>

        {fieldGroups.map((group) => (
          <section key={group.title} className={styles.group}>
            <h3 className={styles.groupTitle}>{group.title}</h3>
            {group.fields.map((field) => (
              <Row
                key={field.key}
                field={field}
                meta={meta}
                isBand={field.key === bandField}
                onChange={onChange}
                onChangeBand={onChangeBand}
              />
            ))}
            {/* Derived read-only R-value, shown right under the U-factor it comes from. */}
            {group.fields.some((f) => f.key === 'uFactor') && meta.uFactor != null && (
              <div className={styles.row}>
                <span className={styles.label}>R-value</span>
                <span className={styles.derived}>
                  {derivedRValue(meta.uFactor)} <span className={styles.unit}>h·ft²·°F/Btu</span>
                </span>
              </div>
            )}
          </section>
        ))}
      </div>
    </aside>
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function Row({
  field,
  meta,
  isBand,
  onChange,
  onChangeBand,
}: {
  field: FacadeField;
  meta: AssemblyMetadata;
  isBand: boolean;
  onChange: (key: keyof AssemblyMetadata, value: string | number) => void;
  onChangeBand: (inches: number) => void;
}) {
  const value = meta[field.key];
  return (
    <label className={styles.row}>
      <span className={styles.label}>{field.label}</span>
      {field.kind === 'select' ? (
        <select
          className={styles.control}
          value={String(value ?? '')}
          onChange={(e) => onChange(field.key, e.target.value)}
        >
          {field.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : field.kind === 'number' ? (
        <span className={styles.numberWrap}>
          <input
            className={`${styles.control} ${styles.number}`}
            type="number"
            step={field.step ?? 1}
            value={Number(value ?? 0)}
            onChange={(e) => {
              const n = e.target.value === '' ? 0 : Number(e.target.value);
              if (isBand) onChangeBand(n);
              else onChange(field.key, n);
            }}
          />
          {field.unit && <span className={styles.unit}>{field.unit}</span>}
        </span>
      ) : (
        <input
          className={styles.control}
          type="text"
          value={String(value ?? '')}
          onChange={(e) => onChange(field.key, e.target.value)}
        />
      )}
    </label>
  );
}
