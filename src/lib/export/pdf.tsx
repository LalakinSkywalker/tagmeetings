// =============================================================================
// Generador PDF con branding (@react-pdf/renderer)
// =============================================================================
// Construye los documentos PDF (elementos React de @react-pdf, NO del DOM). El
// render a Blob/Buffer lo hace el call site:
//   - cliente (descarga / compartir): pdfElementToBlob()
// - server (descarga + archivado en Drive, Fase 6C): renderToBuffer()
//
// Branding del usuario: color de acento + logo opcionales. Si el usuario
// configuró su marca (Ajustes), se inyecta aquí. Sin branding → naranja Bluntag +
// wordmark "TagMeetings" (default histórico).
//
// Este modulo es PESADO: importarlo solo de forma dinamica (import()) desde el
// handler del cliente para que quede en su propio chunk y no infle el bundle.
// =============================================================================

import {
  Document,
  type DocumentProps,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
} from '@react-pdf/renderer'
import type { ReactElement } from 'react'
import type { ExportData } from './export-data'
import {
  formatCustomFieldKey,
  formatTimestampSmart,
  metaPairs,
  type TranscripcionOpts,
} from './format'

const DEFAULT_BRAND = '#ff8133'
const GRAY = '#78716c'
const DARK = '#1c1917'

/** Branding del PDF. Resuelto server-side desde user_settings. */
export interface PdfBranding {
  /** Color de acento (hex #rrggbb). Default naranja Bluntag. */
  accent?: string
  /** Logo del usuario como data URI (PNG/JPG). Si está, reemplaza el wordmark. */
  logoDataUri?: string | null
}

type Styles = ReturnType<typeof makeStyles>

function makeStyles(accent: string) {
  return StyleSheet.create({
    page: {
      paddingTop: 44,
      paddingBottom: 56,
      paddingHorizontal: 46,
      fontSize: 11,
      fontFamily: 'Helvetica',
      color: DARK,
      lineHeight: 1.5,
    },
    brandbar: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
    wordmark: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: accent, letterSpacing: 0.5 },
    logo: { height: 22, objectFit: 'contain' },
    rule: { borderBottomWidth: 1.5, borderBottomColor: accent, marginBottom: 16, marginTop: 4 },
    title: { fontSize: 21, fontFamily: 'Helvetica-Bold', color: DARK, marginBottom: 4 },
    meta: { fontSize: 9, color: GRAY, marginBottom: 18 },
    h2: {
      fontSize: 11,
      fontFamily: 'Helvetica-Bold',
      color: accent,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      marginTop: 16,
      marginBottom: 6,
    },
    para: { fontSize: 11, marginBottom: 6 },
    bulletRow: { flexDirection: 'row', marginBottom: 4, paddingRight: 6 },
    dot: { width: 10, fontSize: 11, color: accent },
    bulletText: { flex: 1, fontSize: 11 },
    aiText: { flex: 1, fontSize: 11 },
    aiMeta: { fontSize: 9, color: GRAY, marginTop: 1 },
    segRow: { marginBottom: 7 },
    segHead: { flexDirection: 'row', marginBottom: 1 },
    segTime: { fontSize: 8.5, color: GRAY, marginRight: 6 },
    segSpeaker: { fontSize: 9.5, fontFamily: 'Helvetica-Bold', color: accent },
    segText: { fontSize: 10.5 },
    footer: {
      position: 'absolute',
      bottom: 28,
      left: 46,
      right: 46,
      flexDirection: 'row',
      justifyContent: 'space-between',
      fontSize: 8,
      color: GRAY,
    },
  })
}

function Header({ s, branding }: { s: Styles; branding?: PdfBranding }) {
  return (
    <View>
      <View style={s.brandbar}>
        {branding?.logoDataUri ? (
          // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf Image no acepta alt
          <Image style={s.logo} src={branding.logoDataUri} />
        ) : (
          <Text style={s.wordmark}>TagMeetings</Text>
        )}
      </View>
      <View style={s.rule} />
    </View>
  )
}

function Footer({ s }: { s: Styles }) {
  return (
    <View style={s.footer} fixed>
      <Text>TagMeetings</Text>
    </View>
  )
}

function TitleBlock({ s, data }: { s: Styles; data: ExportData }) {
  const meta = metaPairs(data)
    .map(([k, v]) => `${k}: ${v}`)
    .join('   ·   ')
  return (
    <View>
      <Text style={s.title}>{data.meta.titulo}</Text>
      {meta ? <Text style={s.meta}>{meta}</Text> : null}
    </View>
  )
}

function Bullet({ s, children }: { s: Styles; children: string }) {
  return (
    <View style={s.bulletRow} wrap={false}>
      <Text style={s.dot}>•</Text>
      <Text style={s.bulletText}>{children}</Text>
    </View>
  )
}

function CustomField({ s, value }: { s: Styles; value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <Text style={s.para}>(vacío)</Text>
    return (
      <>
        {value.map((v, i) => (
          <Bullet key={i} s={s}>
            {typeof v === 'string' ? v : JSON.stringify(v)}
          </Bullet>
        ))}
      </>
    )
  }
  if (typeof value === 'string') return <Text style={s.para}>{value}</Text>
  if (value === null || value === undefined) return <Text style={s.para}>(vacío)</Text>
  return <Text style={s.para}>{JSON.stringify(value, null, 2)}</Text>
}

export function buildAnalisisPdfDoc(
  data: ExportData,
  branding?: PdfBranding,
): ReactElement<DocumentProps> {
  const s = makeStyles(branding?.accent || DEFAULT_BRAND)
  const { analisis } = data
  return (
    <Document title={data.meta.titulo}>
      <Page size="A4" style={s.page}>
        <Header s={s} branding={branding} />
        <TitleBlock s={s} data={data} />
        {!analisis ? (
          <Text style={s.para}>(Sin análisis disponible)</Text>
        ) : (
          <>
            {analisis.resumen ? (
              <>
                <Text style={s.h2}>Resumen</Text>
                <Text style={s.para}>{analisis.resumen}</Text>
              </>
            ) : null}
            {analisis.bullets.length > 0 ? (
              <>
                <Text style={s.h2}>Puntos clave</Text>
                {analisis.bullets.map((b, i) => (
                  <Bullet key={i} s={s}>
                    {b}
                  </Bullet>
                ))}
              </>
            ) : null}
            {analisis.actionItems.length > 0 ? (
              <>
                <Text style={s.h2}>Action items</Text>
                {analisis.actionItems.map((ai, i) => {
                  const extra: string[] = []
                  if (ai.owner) extra.push(`Responsable: ${ai.owner}`)
                  if (ai.dueDate) extra.push(`Para: ${ai.dueDate}`)
                  return (
                    <View key={i} style={s.bulletRow} wrap={false}>
                      <Text style={s.dot}>•</Text>
                      <View style={s.aiText}>
                        <Text>{ai.texto}</Text>
                        {extra.length ? <Text style={s.aiMeta}>{extra.join(' · ')}</Text> : null}
                      </View>
                    </View>
                  )
                })}
              </>
            ) : null}
            {Object.entries(analisis.customFields).map(([key, val]) => (
              <View key={key}>
                <Text style={s.h2}>{formatCustomFieldKey(key)}</Text>
                <CustomField s={s} value={val} />
              </View>
            ))}
          </>
        )}
        <Footer s={s} />
      </Page>
    </Document>
  )
}

export function buildTranscripcionPdfDoc(
  data: ExportData,
  opts: TranscripcionOpts,
  branding?: PdfBranding,
): ReactElement<DocumentProps> {
  const s = makeStyles(branding?.accent || DEFAULT_BRAND)
  return (
    <Document title={`${data.meta.titulo} — Transcripción`}>
      <Page size="A4" style={s.page}>
        <Header s={s} branding={branding} />
        <TitleBlock s={s} data={data} />
        {data.segments.length > 0 ? (
          data.segments.map((seg, i) => (
            <View key={i} style={s.segRow} wrap={false}>
              {opts.incluirTimestamps || opts.incluirHablantes ? (
                <View style={s.segHead}>
                  {opts.incluirTimestamps ? (
                    <Text style={s.segTime}>{formatTimestampSmart(seg.startMs)}</Text>
                  ) : null}
                  {opts.incluirHablantes ? (
                    <Text style={s.segSpeaker}>{seg.speaker}</Text>
                  ) : null}
                </View>
              ) : null}
              <Text style={s.segText}>{seg.text}</Text>
            </View>
          ))
        ) : data.rawText ? (
          <Text style={s.para}>{data.rawText}</Text>
        ) : (
          <Text style={s.para}>(Sin transcripción disponible)</Text>
        )}
        <Footer s={s} />
      </Page>
    </Document>
  )
}
