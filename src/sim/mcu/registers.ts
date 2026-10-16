// The ATmega328P's I/O registers as the firmware names them. The simulator
// models the ADC's registers (free-running conversions and ISR(ADC_vect)) and
// SREG's interrupt flag; any other register gets a clear "not modelled yet"
// error rather than "not declared".

/** Registers the board models, with their width in bits. */
export const MODELLED_REGISTERS: Record<string, 8 | 16> = {
  ADMUX: 8,
  ADCSRA: 8,
  ADCSRB: 8,
  ADCL: 8,
  ADCH: 8,
  ADC: 16,
  ADCW: 16,
  DIDR0: 8,
  SREG: 8,
};

/** Every register name avr/io.h gives the ATmega328P, so a sketch that uses one gets a useful message. */
export const AVR_REGISTERS = new Set([
  ...Object.keys(MODELLED_REGISTERS),
  ..."PINB DDRB PORTB PINC DDRC PORTC PIND DDRD PORTD TIFR0 TIFR1 TIFR2 PCIFR EIFR EIMSK GPIOR0 EECR EEDR EEAR EEARL EEARH GTCCR TCCR0A TCCR0B TCNT0 OCR0A OCR0B GPIOR1 GPIOR2 SPCR SPSR SPDR ACSR SMCR MCUSR MCUCR SPMCSR SPL SPH SP WDTCSR CLKPR PRR OSCCAL PCICR EICRA PCMSK0 PCMSK1 PCMSK2 TIMSK0 TIMSK1 TIMSK2 DIDR1 TCCR1A TCCR1B TCCR1C TCNT1 TCNT1L TCNT1H ICR1 ICR1L ICR1H OCR1A OCR1AL OCR1AH OCR1B OCR1BL OCR1BH TCCR2A TCCR2B TCNT2 OCR2A OCR2B ASSR TWBR TWSR TWAR TWDR TWCR TWAMR UCSR0A UCSR0B UCSR0C UBRR0 UBRR0L UBRR0H UDR0".split(
    " ",
  ),
]);

export const UNMODELLED_REGISTER = (name: string, mcu: string) =>
  `${name} is an ${mcu} register the simulator does not model yet. It models the ADC (ADMUX, ADCSRA, ADCSRB, ADCL, ADCH, ADC, DIDR0) and SREG; use the Arduino functions (digitalWrite, analogWrite, millis, attachInterrupt) for the rest`;

/** Interrupt vectors the board runs when the firmware defines them with ISR(). */
export const MODELLED_VECTORS = ["ADC_vect"];

/** avr/io.h: the bit numbers of the modelled registers, and the bit helpers. */
export const AVR_IO_H = `#pragma once
#define _BV(bit) (1 << (bit))
#define bit_is_set(sfr, bit) ((sfr) & _BV(bit))
#define bit_is_clear(sfr, bit) (!((sfr) & _BV(bit)))
#define loop_until_bit_is_set(sfr, bit) do { } while (bit_is_clear(sfr, bit))
#define loop_until_bit_is_clear(sfr, bit) do { } while (bit_is_set(sfr, bit))
/* ADMUX */
#define REFS1 7
#define REFS0 6
#define ADLAR 5
#define MUX3 3
#define MUX2 2
#define MUX1 1
#define MUX0 0
/* ADCSRA */
#define ADEN 7
#define ADSC 6
#define ADATE 5
#define ADIF 4
#define ADIE 3
#define ADPS2 2
#define ADPS1 1
#define ADPS0 0
/* ADCSRB */
#define ACME 6
#define ADTS2 2
#define ADTS1 1
#define ADTS0 0
/* DIDR0 */
#define ADC5D 5
#define ADC4D 4
#define ADC3D 3
#define ADC2D 2
#define ADC1D 1
#define ADC0D 0
/* SREG */
#define SREG_I 7
`;

/** avr/interrupt.h: ISR() defines the handler as a plain function the board calls by its vector's name. */
export const AVR_INTERRUPT_H = `#pragma once
#define ISR_BLOCK
#define ISR_NOBLOCK
#define ISR_NAKED
#define ISR(vector, ...) void vector(void)
#define EMPTY_INTERRUPT(vector) void vector(void) {}
`;
