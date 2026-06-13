import { describe, expect, it } from 'vitest'
import { diasParaExpirar, decidirAccion, planBorrado, MS_POR_DIA } from './lifecycle-rules'

const AHORA = 1_000 * MS_POR_DIA // un "ahora" arbitrario en ms (dia 1000)

/** Helper: timestamp de hace N dias respecto a AHORA. */
const haceDias = (n: number) => AHORA - n * MS_POR_DIA

describe('diasParaExpirar', () => {
  it('retencion null => Infinity (nunca borrar)', () => {
    expect(diasParaExpirar({ baseMs: haceDias(500), retencionDias: null, ahoraMs: AHORA })).toBe(Infinity)
  })

  it('audio reciente con retencion 30 => ~quedan 30', () => {
    expect(diasParaExpirar({ baseMs: AHORA, retencionDias: 30, ahoraMs: AHORA })).toBeCloseTo(30, 5)
  })

  it('audio de hace 25 dias con retencion 30 => quedan ~5', () => {
    expect(diasParaExpirar({ baseMs: haceDias(25), retencionDias: 30, ahoraMs: AHORA })).toBeCloseTo(5, 5)
  })

  it('audio de hace 40 dias con retencion 30 => negativo (vencido)', () => {
    expect(diasParaExpirar({ baseMs: haceDias(40), retencionDias: 30, ahoraMs: AHORA })).toBeLessThan(0)
  })
})

describe('decidirAccion', () => {
  const base = { ahoraMs: AHORA, avisoActivo: true, avisoDias: 3, avisoYaEnviado: false }

  it('retencion null => skip', () => {
    expect(decidirAccion({ ...base, retencionDias: null, baseMs: haceDias(999) })).toBe('skip')
  })

  it('vencido (hace 40d, retencion 30) => borrar', () => {
    expect(decidirAccion({ ...base, retencionDias: 30, baseMs: haceDias(40) })).toBe('borrar')
  })

  it('dentro de ventana de aviso (quedan 2d, aviso 3d) y no avisado => avisar', () => {
    expect(decidirAccion({ ...base, retencionDias: 30, baseMs: haceDias(28) })).toBe('avisar')
  })

  it('dentro de ventana pero YA avisado => esperar (no re-avisa)', () => {
    expect(
      decidirAccion({ ...base, avisoYaEnviado: true, retencionDias: 30, baseMs: haceDias(28) }),
    ).toBe('esperar')
  })

  it('dentro de ventana pero aviso desactivado => esperar', () => {
    expect(
      decidirAccion({ ...base, avisoActivo: false, retencionDias: 30, baseMs: haceDias(28) }),
    ).toBe('esperar')
  })

  it('lejos de expirar (quedan 20d) => esperar', () => {
    expect(decidirAccion({ ...base, retencionDias: 30, baseMs: haceDias(10) })).toBe('esperar')
  })

  it('vencido tiene prioridad sobre aviso', () => {
    expect(decidirAccion({ ...base, retencionDias: 30, baseMs: haceDias(31) })).toBe('borrar')
  })
})

describe('planBorrado (salvaguarda dura)', () => {
  it('off => borra directo', () => {
    expect(planBorrado({ respaldoModo: 'off', tieneRespaldoPrevio: false })).toEqual({
      borrarDirecto: true,
      respaldarPrimero: false,
      bloqueado: false,
    })
  })

  it('auto => respalda primero (no borra directo)', () => {
    expect(planBorrado({ respaldoModo: 'auto', tieneRespaldoPrevio: false })).toEqual({
      borrarDirecto: false,
      respaldarPrimero: true,
      bloqueado: false,
    })
  })

  it('manual CON respaldo previo => borra directo', () => {
    expect(planBorrado({ respaldoModo: 'manual', tieneRespaldoPrevio: true })).toEqual({
      borrarDirecto: true,
      respaldarPrimero: false,
      bloqueado: false,
    })
  })

  it('manual SIN respaldo previo => BLOQUEADO (salvaguarda impide borrar)', () => {
    expect(planBorrado({ respaldoModo: 'manual', tieneRespaldoPrevio: false })).toEqual({
      borrarDirecto: false,
      respaldarPrimero: false,
      bloqueado: true,
    })
  })
})
