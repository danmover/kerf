// The ATmega328P's I/O registers as the firmware names them. The simulator
// models the ADC's registers (free-running conversions and ISR(ADC_vect)), the
// I2C clock (TWBR, TWSR's prescaler), SREG's interrupt flag, and (engine/timers.ts) the ports, the external and
// pin-change interrupts and timers 0, 1 and 2; any other register gets a clear "not modelled yet" error rather
// than "not declared".

import { AVR_CHIP_REGISTERS } from "../engine/timers";

/** Registers the board models, with their width in bits. */
export const MODELLED_REGISTERS: Record<string, 8 | 16> = {
  ...AVR_CHIP_REGISTERS,
  ADMUX: 8,
  ADCSRA: 8,
  ADCSRB: 8,
  ADCL: 8,
  ADCH: 8,
  ADC: 16,
  ADCW: 16,
  DIDR0: 8,
  TWBR: 8,
  TWSR: 8,
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
  mcu !== "ATmega328P"
    ? `${name} is an ${mcu} register the simulator does not model: it models the ATmega328P's (Uno, Nano), and SREG on every AVR. Use the Arduino functions (digitalWrite, analogRead, Serial, SPI.transfer) on the ${mcu}`
    : `${name} is an ${mcu} register the simulator does not model yet. It models the ports (PORTx, DDRx, PINx), timers 0, 1 and 2 (TCCRnA/B, TCNTn, OCRnA/B, ICR1, TIMSKn, TIFRn), the external and pin-change interrupts (EICRA, EIMSK, EIFR, PCICR, PCIFR, PCMSKn), the ADC (ADMUX, ADCSRA, ADCSRB, ADCL, ADCH, ADC, DIDR0), the I2C clock (TWBR, TWSR) and SREG; use the Arduino functions (SPI.transfer, Serial) for the rest`;

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
/* TWSR */
#define TWS7 7
#define TWS6 6
#define TWS5 5
#define TWS4 4
#define TWS3 3
#define TWPS1 1
#define TWPS0 0
/* SREG */
#define SREG_I 7
/* ports */
#define PB0 0
#define PORTB0 0
#define DDB0 0
#define PINB0 0
#define PB1 1
#define PORTB1 1
#define DDB1 1
#define PINB1 1
#define PB2 2
#define PORTB2 2
#define DDB2 2
#define PINB2 2
#define PB3 3
#define PORTB3 3
#define DDB3 3
#define PINB3 3
#define PB4 4
#define PORTB4 4
#define DDB4 4
#define PINB4 4
#define PB5 5
#define PORTB5 5
#define DDB5 5
#define PINB5 5
#define PB6 6
#define PORTB6 6
#define DDB6 6
#define PINB6 6
#define PB7 7
#define PORTB7 7
#define DDB7 7
#define PINB7 7
#define PC0 0
#define PORTC0 0
#define DDC0 0
#define PINC0 0
#define PC1 1
#define PORTC1 1
#define DDC1 1
#define PINC1 1
#define PC2 2
#define PORTC2 2
#define DDC2 2
#define PINC2 2
#define PC3 3
#define PORTC3 3
#define DDC3 3
#define PINC3 3
#define PC4 4
#define PORTC4 4
#define DDC4 4
#define PINC4 4
#define PC5 5
#define PORTC5 5
#define DDC5 5
#define PINC5 5
#define PC6 6
#define PORTC6 6
#define DDC6 6
#define PINC6 6
#define PD0 0
#define PORTD0 0
#define DDD0 0
#define PIND0 0
#define PD1 1
#define PORTD1 1
#define DDD1 1
#define PIND1 1
#define PD2 2
#define PORTD2 2
#define DDD2 2
#define PIND2 2
#define PD3 3
#define PORTD3 3
#define DDD3 3
#define PIND3 3
#define PD4 4
#define PORTD4 4
#define DDD4 4
#define PIND4 4
#define PD5 5
#define PORTD5 5
#define DDD5 5
#define PIND5 5
#define PD6 6
#define PORTD6 6
#define DDD6 6
#define PIND6 6
#define PD7 7
#define PORTD7 7
#define DDD7 7
#define PIND7 7
/* EICRA, EIMSK, EIFR */
#define ISC11 3
#define ISC10 2
#define ISC01 1
#define ISC00 0
#define INT1 1
#define INT0 0
#define INTF1 1
#define INTF0 0
/* PCICR, PCIFR, PCMSKn */
#define PCIE2 2
#define PCIE1 1
#define PCIE0 0
#define PCIF2 2
#define PCIF1 1
#define PCIF0 0
#define PCINT0 0
#define PCINT1 1
#define PCINT2 2
#define PCINT3 3
#define PCINT4 4
#define PCINT5 5
#define PCINT6 6
#define PCINT7 7
#define PCINT8 0
#define PCINT9 1
#define PCINT10 2
#define PCINT11 3
#define PCINT12 4
#define PCINT13 5
#define PCINT14 6
#define PCINT16 0
#define PCINT17 1
#define PCINT18 2
#define PCINT19 3
#define PCINT20 4
#define PCINT21 5
#define PCINT22 6
#define PCINT23 7
/* timer 0 */
#define COM0A1 7
#define COM0A0 6
#define COM0B1 5
#define COM0B0 4
#define WGM01 1
#define WGM00 0
#define FOC0A 7
#define FOC0B 6
#define WGM02 3
#define CS02 2
#define CS01 1
#define CS00 0
#define OCIE0B 2
#define OCIE0A 1
#define TOIE0 0
#define OCF0B 2
#define OCF0A 1
#define TOV0 0
/* timer 1 */
#define COM1A1 7
#define COM1A0 6
#define COM1B1 5
#define COM1B0 4
#define WGM11 1
#define WGM10 0
#define ICNC1 7
#define ICES1 6
#define WGM13 4
#define WGM12 3
#define CS12 2
#define CS11 1
#define CS10 0
#define FOC1A 7
#define FOC1B 6
#define ICIE1 5
#define OCIE1B 2
#define OCIE1A 1
#define TOIE1 0
#define ICF1 5
#define OCF1B 2
#define OCF1A 1
#define TOV1 0
/* timer 2 */
#define COM2A1 7
#define COM2A0 6
#define COM2B1 5
#define COM2B0 4
#define WGM21 1
#define WGM20 0
#define FOC2A 7
#define FOC2B 6
#define WGM22 3
#define CS22 2
#define CS21 1
#define CS20 0
#define OCIE2B 2
#define OCIE2A 1
#define TOIE2 0
#define OCF2B 2
#define OCF2A 1
#define TOV2 0
/* pins_arduino.h: a pin's pin-change register and bit */
#define digitalPinToPCICR(p) (((p) >= 0 && (p) <= 21) ? (&PCICR) : ((uint8_t *)0))
#define digitalPinToPCICRbit(p) (((p) <= 7) ? 2 : (((p) <= 13) ? 0 : 1))
#define digitalPinToPCMSK(p) (((p) <= 7) ? (&PCMSK2) : (((p) <= 13) ? (&PCMSK0) : (((p) <= 21) ? (&PCMSK1) : ((uint8_t *)0))))
#define digitalPinToPCMSKbit(p) (((p) <= 7) ? (p) : (((p) <= 13) ? ((p) - 8) : ((p) - 14)))
`;

/** avr/interrupt.h: ISR() defines the handler as a plain function the board calls by its vector's name. */
export const AVR_INTERRUPT_H = `#pragma once
#define ISR_BLOCK
#define ISR_NOBLOCK
#define ISR_NAKED
#define ISR(vector, ...) void vector(void)
#define EMPTY_INTERRUPT(vector) void vector(void) {}
`;
