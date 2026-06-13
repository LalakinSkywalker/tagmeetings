import { describe, expect, it } from 'vitest'
import { combinarFuentes, type FuenteParaCombinar } from './combinar'

const audioA: FuenteParaCombinar = {
  orden: 0,
  tipo: 'audio',
  nombre: 'Reunion parte 1.mp3',
  duracion_ms: 10000,
  segments: [
    { speaker: { id: 0 }, text: 'Hola que tal', start_ms: 0, end_ms: 2000, confidence: 0.9 },
    { speaker: { id: 1 }, text: 'Bien gracias', start_ms: 2100, end_ms: 4000, confidence: 0.9 },
  ],
}

const audioB: FuenteParaCombinar = {
  orden: 1,
  tipo: 'video',
  nombre: 'Reunion parte 2.mp4',
  duracion_ms: 8000,
  segments: [
    { speaker: { id: 0 }, text: 'Continuamos', start_ms: 0, end_ms: 1500, confidence: 0.9 },
  ],
}

const pdf: FuenteParaCombinar = {
  orden: 2,
  tipo: 'pdf',
  nombre: 'Propuesta.pdf',
  texto_extraido: 'Propuesta comercial: 3 fases, total 120 mil.',
}

describe('combinarFuentes — merge multi-fuente', () => {
  it('namespacea hablantes por fuente (no empareja cross-archivo)', () => {
    const { transcription } = combinarFuentes([audioA, audioB])
    const ids = transcription.segments.map((s) => s.speaker.id)
    // Fuente 0: 0, 1 ; Fuente 1: 100 (orden*100 + idOriginal)
    expect(ids).toEqual([0, 1, 100])
  })

  it('desplaza el timeline por duración acumulada (orden monótono)', () => {
    const { transcription } = combinarFuentes([audioA, audioB])
    // El segmento de la fuente B arranca tras la duración de A (10000ms)
    const segB = transcription.segments.find((s) => s.speaker.id === 100)!
    expect(segB.start_ms).toBe(10000)
    expect(segB.end_ms).toBe(11500)
    expect(transcription.duration_ms).toBe(18000) // 10000 + 8000
  })

  it('inyecta encabezado de fuente en el primer segmento de cada fuente', () => {
    const { transcription } = combinarFuentes([audioA, audioB])
    expect(transcription.segments[0]!.text).toContain('— Fuente 1: Reunion parte 1.mp3')
    expect(transcription.segments[0]!.text).toContain('Hola que tal')
    // El segundo segmento de la fuente 1 NO lleva header
    expect(transcription.segments[1]!.text).toBe('Bien gracias')
    // Primer segmento de la fuente 2 lleva su header
    expect(transcription.segments[2]!.text).toContain('— Fuente 2: Reunion parte 2.mp4')
  })

  it('auto-pobla speaker_names legibles para los ids namespaceados', () => {
    const { speakerNames } = combinarFuentes([audioA, audioB])
    expect(speakerNames['0']).toBe('F1 · Hablante 0')
    expect(speakerNames['1']).toBe('F1 · Hablante 1')
    expect(speakerNames['100']).toBe('F2 · Hablante 0')
  })

  it('inyecta documentos (pdf) como pseudo-segmento de texto al final', () => {
    const { transcription, speakerNames } = combinarFuentes([audioA, pdf])
    const docSeg = transcription.segments.find((s) => s.speaker.id === 9000)!
    expect(docSeg).toBeDefined()
    expect(docSeg.text).toContain('— Fuente 3: Propuesta.pdf (PDF) —')
    expect(docSeg.text).toContain('Propuesta comercial')
    expect(speakerNames['9000']).toBe('Documento: Propuesta.pdf')
    // El raw_text combinado contiene ambos bloques
    expect(transcription.raw_text).toContain('Reunion parte 1')
    expect(transcription.raw_text).toContain('Propuesta comercial')
  })

  it('ordena por `orden` aunque lleguen desordenadas', () => {
    const { transcription } = combinarFuentes([audioB, audioA]) // B(orden1) antes que A(orden0)
    // Tras ordenar, el primer segmento debe ser de la fuente 0 (audioA)
    expect(transcription.segments[0]!.speaker.id).toBe(0)
  })

  it('omite documentos con texto vacío', () => {
    const vacio: FuenteParaCombinar = { orden: 1, tipo: 'doc', nombre: 'vacio.docx', texto_extraido: '   ' }
    const { transcription } = combinarFuentes([audioA, vacio])
    // Solo los 2 segmentos de audioA, sin pseudo-segmento de doc
    expect(transcription.segments.length).toBe(2)
  })

  it('provider del resultado combinado es "multifuente"', () => {
    const { transcription } = combinarFuentes([audioA])
    expect(transcription.provider).toBe('multifuente')
  })
})
