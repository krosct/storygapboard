import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { parseLayout, parseRatio, previewBoard, restyleGeometry, type PanelSource } from '../board'
import ColorPicker from './ColorPicker'
import {
  BACKGROUNDS, CORNERS, DEFAULT_FRAME, frameGeometry, LINE_KINDS, NUMBER_SHAPES, presetStyle, PRESETS, TITLE_FONTS, TITLE_MAX,
  type Align, type Background, type Corner, type FrameGeometry, type FrameStyle, type LineKind, type NumberShape, type TitleFont,
} from '../frame'

interface Props {
  style: FrameStyle
  onChange: (style: FrameStyle) => void
  layout: string
  aspectRatio: string
  /** the current storyboard, if any: the preview then shows its real panels */
  board: (FrameGeometry & { sources: PanelSource[] }) | null
}

const PREVIEW_WIDTH = 720
const SECTIONS = ["Looks", "Background", "Outer frame", "Title", "Panel border", "Panel numbers"]

interface FieldProps { id: string; label: string; disabled?: boolean; wide?: 2 | 3 }

function Field(p: FieldProps & { children: ReactNode; value?: ReactNode }) {
  return (
    <div className={`field frame-field${p.disabled ? ' is-disabled' : ''}${p.wide ? ` span-${p.wide}` : ''}`}>
      <label htmlFor={p.id}>{p.label}{p.value !== undefined && <span className="frame-value">{p.value}</span>}</label>
      {p.children}
    </div>
  )
}

function Slider(p: FieldProps & { value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <Field id={p.id} label={p.label} disabled={p.disabled} value={`${Number(p.value.toFixed(2))}${p.unit ?? ''}`}>
      <input id={p.id} type="range" min={p.min} max={p.max} step={p.step} value={p.value} disabled={p.disabled}
        onChange={(e) => p.onChange(Number(e.target.value))} />
    </Field>
  )
}

function ColorField(p: FieldProps & { value: string; onChange: (v: string) => void }) {
  return (
    <Field id={p.id} label={p.label} disabled={p.disabled}>
      <ColorPicker id={p.id} label={p.label} value={p.value} disabled={p.disabled} onChange={p.onChange} />
    </Field>
  )
}

function Choice<T extends string>(p: FieldProps & { value: T; options: Record<T, string>; onChange: (v: T) => void }) {
  return (
    <Field id={p.id} label={p.label} disabled={p.disabled}>
      <select id={p.id} value={p.value} disabled={p.disabled} onChange={(e) => p.onChange(e.target.value as T)}>
        {(Object.keys(p.options) as T[]).map((key) => <option key={key} value={key}>{p.options[key]}</option>)}
      </select>
    </Field>
  )
}

function Toggle(p: { label: string; title: string; on: boolean; disabled?: boolean; style?: CSSProperties; onClick: () => void }) {
  return (
    <button type="button" className={`frame-toggle${p.on ? ' is-on' : ''}`} aria-pressed={p.on} aria-label={p.title}
      title={p.title} disabled={p.disabled} style={p.style} onClick={p.onClick}>{p.label}</button>
  )
}

// One card = one grid of three columns; controls that do not apply stay in place, dimmed, so nothing jumps.
function Card(p: { index: number; card: number; title: string; children: ReactNode }) {
  return (
    <div className={`tab-pane frame-card${p.card === p.index ? '' : ' is-off'}`} role="group" aria-label={p.title}
      aria-hidden={p.card !== p.index}>
      <div className="frame-fields">{p.children}</div>
    </div>
  )
}

// Frame tab: how the storyboard looks around the pictures. The preview shows the real panels once a
// storyboard exists (a numbered sample before), and the storyboard itself follows every change.
export default function FrameTab({ style, onChange, layout, aspectRatio, board }: Props) {
  const view = useRef<HTMLCanvasElement>(null)
  const [card, setCard] = useState(0)
  const set = <K extends keyof FrameStyle>(key: K, value: FrameStyle[K]) => onChange({ ...style, [key]: value })
  const patterned = style.background !== 'solid'
  const hasTitle = style.title.trim() !== ''

  useEffect(() => {
    const el = view.current
    if (!el) return
    let geometry: FrameGeometry
    let sources: PanelSource[] | null = null
    if (board) {
      geometry = restyleGeometry(board, style)
      sources = board.sources
    } else {
      const [rows, cols] = parseLayout(layout)
      const ratio = parseRatio(aspectRatio) ?? 1
      const h = 300
      geometry = frameGeometry(layout, rows, cols, Math.round(h * ratio), h, style)
    }
    let alive = true
    void previewBoard(el, geometry, sources, style, PREVIEW_WIDTH).catch(() => { if (!alive) return })
    return () => { alive = false }
  }, [style, layout, aspectRatio, board])

  return (
    <div className="frame-tab">
      <div className="frame-preview" onContextMenu={(e) => e.preventDefault()} onDragStart={(e) => e.preventDefault()}>
        <canvas ref={view} aria-label="Preview of the storyboard with this frame" />
      </div>

      <div className="frame-nav-title" aria-live="polite">
        <span>{SECTIONS[card]}</span>
        <span className="frame-dots" role="tablist" aria-label="Frame sections">
          {SECTIONS.map((name, i) => (
            <span key={name} role="tab" aria-selected={card === i} aria-label={name} title={name} tabIndex={0}
              className={`frame-dot${card === i ? ' is-on' : ''}`} onClick={() => setCard(i)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCard(i) } }} />
          ))}
        </span>
      </div>

      <div className="frame-body">
        <button type="button" className="frame-arrow icon solid fa-chevron-left" aria-label="Previous section"
          title="Previous section" onClick={() => setCard((card + SECTIONS.length - 1) % SECTIONS.length)} />
        <div className="tab-viewport">
          <div className="tab-track" style={{ transform: `translateX(-${card * 100}%)` }}>

            <Card index={0} card={card} title="Looks">
              <div className="frame-presets span-3" role="group" aria-label="Ready-made looks">
                {PRESETS.map((preset) => (
                  <button key={preset.id} type="button" className="frame-preset" onClick={() => onChange(presetStyle(preset.id, style))}>
                    {preset.label}
                  </button>
                ))}
                <button type="button" className="frame-preset" onClick={() => onChange({ ...DEFAULT_FRAME, title: style.title })}>Reset</button>
              </div>
            </Card>

            <Card index={1} card={card} title="Background">
              <Choice id="fr-bg" label="Type" value={style.background} options={BACKGROUNDS}
                onChange={(v: Background) => set('background', v)} />
              <ColorField id="fr-c1" label="Color" value={style.color1} onChange={(v) => set('color1', v)} />
              <ColorField id="fr-c2" label={style.background === 'linear' || style.background === 'radial' ? 'Second color' : 'Pattern color'}
                disabled={!patterned} value={style.color2} onChange={(v) => set('color2', v)} />
              <Slider id="fr-angle" label="Direction" value={style.angle} min={0} max={360} step={5} unit="°"
                disabled={style.background !== 'linear'} onChange={(v) => set('angle', v)} />
              <Slider id="fr-margin" label="Margin around" value={style.margin} min={0} max={20} step={0.5}
                onChange={(v) => set('margin', v)} />
              <Slider id="fr-gap" label="Space between" value={style.gap} min={0} max={20} step={0.5}
                onChange={(v) => set('gap', v)} />
            </Card>

            <Card index={2} card={card} title="Outer frame">
              <Slider id="fr-ow" label="Thickness" value={style.outerWidth} min={0} max={6} step={0.1} onChange={(v) => set('outerWidth', v)} />
              <ColorField id="fr-oc" label="Color" disabled={style.outerWidth <= 0} value={style.outerColor} onChange={(v) => set('outerColor', v)} />
              <Choice id="fr-ok" label="Line" disabled={style.outerWidth <= 0} value={style.outerKind} options={LINE_KINDS}
                onChange={(v: LineKind) => set('outerKind', v)} />
              <Slider id="fr-or" label="Corner rounding" value={style.outerRadius} min={0} max={30} step={0.5} onChange={(v) => set('outerRadius', v)} />
              <ColorField id="fr-ob" label="Behind the corners" disabled={style.outerRadius <= 0} value={style.outerBehind}
                onChange={(v) => set('outerBehind', v)} />
            </Card>

            <Card index={3} card={card} title="Title">
              <Field id="fr-title" label="Text (optional)" wide={2}>
                <input id="fr-title" type="text" autoComplete="off" maxLength={TITLE_MAX} value={style.title}
                  placeholder="e.g. The Red Panda Returns" onChange={(e) => set('title', e.target.value)} />
              </Field>
              <Field id="fr-tb" label="Style" disabled={!hasTitle}>
                <div className="frame-toggles" role="group" aria-label="Title style">
                  <Toggle label="B" title="Bold" on={style.titleBold} disabled={!hasTitle} style={{ fontWeight: 700 }}
                    onClick={() => set('titleBold', !style.titleBold)} />
                  <Toggle label="I" title="Italic" on={style.titleItalic} disabled={!hasTitle} style={{ fontStyle: 'italic' }}
                    onClick={() => set('titleItalic', !style.titleItalic)} />
                  <Toggle label="U" title="Underline" on={style.titleUnderline} disabled={!hasTitle} style={{ textDecoration: 'underline' }}
                    onClick={() => set('titleUnderline', !style.titleUnderline)} />
                </div>
              </Field>
              <Choice id="fr-tf" label="Font" disabled={!hasTitle} value={style.titleFont}
                options={Object.fromEntries(Object.entries(TITLE_FONTS).map(([k, v]) => [k, v.label])) as Record<TitleFont, string>}
                onChange={(v: TitleFont) => set('titleFont', v)} />
              <Slider id="fr-ts" label="Size" disabled={!hasTitle} value={style.titleSize} min={3} max={25} step={0.5}
                onChange={(v) => set('titleSize', v)} />
              <ColorField id="fr-tc" label="Color" disabled={!hasTitle} value={style.titleColor} onChange={(v) => set('titleColor', v)} />
              <Choice id="fr-ta" label="Align" disabled={!hasTitle} value={style.titleAlign}
                options={{ left: 'Left', center: 'Center', right: 'Right' }} onChange={(v: Align) => set('titleAlign', v)} />
              <Choice id="fr-tp" label="Position" disabled={!hasTitle} value={style.titleAt} options={{ top: 'Top', bottom: 'Bottom' }}
                onChange={(v: 'top' | 'bottom') => set('titleAt', v)} />
              <Slider id="fr-tg" label="Panel distance" disabled={!hasTitle} value={style.titleOffset} min={0} max={100} step={1} unit="%"
                onChange={(v) => set('titleOffset', v)} />
            </Card>

            <Card index={4} card={card} title="Panel border">
              <Slider id="fr-bw" label="Thickness" value={style.borderWidth} min={0} max={8} step={0.1} onChange={(v) => set('borderWidth', v)} />
              <ColorField id="fr-bc" label="Color" disabled={style.borderWidth <= 0} value={style.borderColor} onChange={(v) => set('borderColor', v)} />
              <Choice id="fr-bk" label="Line" disabled={style.borderWidth <= 0} value={style.borderKind} options={LINE_KINDS}
                onChange={(v: LineKind) => set('borderKind', v)} />
              <Slider id="fr-r" label="Rounded corners" value={style.radius} min={0} max={30} step={0.5} onChange={(v) => set('radius', v)} />
              <Slider id="fr-sh" label="Shadow" value={style.shadow} min={0} max={6} step={0.25} onChange={(v) => set('shadow', v)} />
            </Card>

            <Card index={5} card={card} title="Panel numbers">
              <Field id="fr-num" label="Show numbers">
                <div className="frame-toggles">
                  <Toggle label={style.numbers ? 'On' : 'Off'} title="Show panel numbers" on={style.numbers}
                    onClick={() => set('numbers', !style.numbers)} />
                </div>
              </Field>
              <Choice id="fr-na" label="Corner" disabled={!style.numbers} value={style.numberAt} options={CORNERS}
                onChange={(v: Corner) => set('numberAt', v)} />
              <Choice id="fr-ns" label="Shape" disabled={!style.numbers} value={style.numberShape} options={NUMBER_SHAPES}
                onChange={(v: NumberShape) => set('numberShape', v)} />
              <Slider id="fr-nz" label="Size" disabled={!style.numbers} value={style.numberSize} min={3} max={25} step={0.5}
                onChange={(v) => set('numberSize', v)} />
              <ColorField id="fr-nc" label="Badge color" disabled={!style.numbers} value={style.numberColor}
                onChange={(v) => set('numberColor', v)} />
              <ColorField id="fr-nt" label="Number color" disabled={!style.numbers} value={style.numberText}
                onChange={(v) => set('numberText', v)} />
            </Card>

          </div>
        </div>
        <button type="button" className="frame-arrow icon solid fa-chevron-right" aria-label="Next section"
          title="Next section" onClick={() => setCard((card + 1) % SECTIONS.length)} />
      </div>
    </div>
  )
}
