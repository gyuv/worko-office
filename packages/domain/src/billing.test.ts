import { describe, expect, it } from 'vitest';
import {
  ageingBucket, allocateFifo, amountInWords, balanceOf, buildTallyXml, computeInvoice, docNumber, dueStep, invoiceVoucher, lineTax, receiptVoucher,
  SEED_LADDER, supplyTypeOf,
} from './index.js';

describe('GST split', () => {
  it('intra-state → equal CGST + SGST halves; inter-state → IGST; unregistered supplier → no tax', () => {
    expect(supplyTypeOf('27AAAAA0000A1Z5', '27', '27')).toBe('intra');
    expect(supplyTypeOf('27AAAAA0000A1Z5', '27', '29')).toBe('inter');
    expect(supplyTypeOf(null, '27', '29')).toBe('unregistered');
    expect(lineTax({ qty: 1, ratePaise: 100_000, gstRate: 18 }, 'intra')).toMatchObject({ taxablePaise: 100_000, cgstPaise: 9_000, sgstPaise: 9_000, igstPaise: 0, totalPaise: 118_000 });
    expect(lineTax({ qty: 1, ratePaise: 100_000, gstRate: 18 }, 'inter')).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 18_000 });
    expect(lineTax({ qty: 1, ratePaise: 100_000, gstRate: 18 }, 'unregistered')).toMatchObject({ taxablePaise: 100_000, cgstPaise: 0, igstPaise: 0, totalPaise: 100_000 });
    expect(lineTax({ qty: 1, ratePaise: 100_000, gstRate: 0 }, 'intra')).toMatchObject({ cgstPaise: 0, totalPaise: 100_000 }); // exempt
  });
  it('reimbursements are outside the taxable value and carry no GST', () => {
    const t = computeInvoice([{ qty: 1, ratePaise: 500_000, gstRate: 18 }, { qty: 1, ratePaise: 20_000, gstRate: 18, reimbursement: true }], 'intra');
    expect(t).toMatchObject({ taxablePaise: 500_000, cgstPaise: 45_000, sgstPaise: 45_000, reimbursementPaise: 20_000, totalPaise: 610_000, roundOffPaise: 0 });
  });
  it('rounds per line to paise and the total to the rupee with a round-off', () => {
    // 3 × ₹333.33 = ₹999.99, less ₹0.99 discount = ₹999.00; 9% = ₹89.91 each half → ₹1,178.82 → ₹1,179 (+0.18)
    const t = computeInvoice([{ qty: 3, ratePaise: 33_333, discountPaise: 99, gstRate: 18 }], 'intra');
    expect(t).toMatchObject({ taxablePaise: 99_900, cgstPaise: 8_991, sgstPaise: 8_991, totalPaise: 117_900, roundOffPaise: 18 });
    const down = computeInvoice([{ qty: 1, ratePaise: 100_033, gstRate: 18 }], 'inter'); // 1000.33 + 180.06 = 1180.39 → 1180
    expect(down).toMatchObject({ igstPaise: 18_006, totalPaise: 118_000, roundOffPaise: -39 });
    expect(computeInvoice([{ qty: 1, ratePaise: 100_033, gstRate: 18 }], 'inter', { roundToRupee: false }).totalPaise).toBe(118_039);
    expect(() => lineTax({ qty: 1, ratePaise: 100, discountPaise: 200, gstRate: 18 }, 'intra')).toThrow();
  });
});

describe('receivables', () => {
  it('balance = total − allocations − TDS − credit notes', () => {
    expect(balanceOf({ totalPaise: 118_000, allocatedPaise: 90_000, tdsPaise: 10_000, creditedPaise: 18_000 })).toBe(0);
  });
  it('FIFO allocation applies TDS first, then cash, leaving an advance', () => {
    const r = allocateFifo(150_000, 10_000, [{ id: 'a', balancePaise: 100_000 }, { id: 'b', balancePaise: 50_000 }, { id: 'c', balancePaise: 0 }]);
    expect(r.allocations).toEqual([{ invoiceId: 'a', amountPaise: 90_000, tdsPaise: 10_000 }, { invoiceId: 'b', amountPaise: 50_000, tdsPaise: 0 }]);
    expect(r.advance).toEqual({ amountPaise: 10_000, tdsPaise: 0 });
    expect(allocateFifo(10_000, 0, []).advance.amountPaise).toBe(10_000);
  });
  it('ageing buckets by days past due', () => {
    expect([-3, 0, 1, 30, 31, 60, 61, 90, 91].map(ageingBucket)).toEqual(['notDue', 'notDue', 'd0_30', 'd0_30', 'd31_60', 'd31_60', 'd61_90', 'd61_90', 'd90plus']);
  });
  it('follow-up ladder picks the latest step reached', () => {
    expect(dueStep(SEED_LADDER, '2026-10-01', '2026-09-30')).toBeNull();
    expect(dueStep(SEED_LADDER, '2026-10-01', '2026-10-01')!.step).toBe(0);
    expect(dueStep(SEED_LADDER, '2026-10-01', '2026-10-10')!.step).toBe(1);
    expect(dueStep(SEED_LADDER, '2026-10-01', '2026-12-01')!.step).toBe(2);
  });
  it('numbers fit the 16-character limit and words follow the Indian system', () => {
    expect(docNumber('SMA', 'invoice', 2026, 7)).toBe('SMA/2627/0007');
    expect(docNumber('ABCD', 'credit_note', 2099, 12)).toBe('ABCDCN/9900/0012');
    expect(docNumber('ABCD', 'credit_note', 2099, 12).length).toBeLessThanOrEqual(16);
    expect(amountInWords(11_800_000)).toBe('Rupees One Lakh Eighteen Thousand Only');
    expect(amountInWords(1_234_567_850)).toBe('Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only');
  });
});

describe('Tally XML', () => {
  const inv = invoiceVoucher({ id: 'i1', kind: 'invoice', number: 'SMA/2627/0001', date: '2026-09-30', clientId: 'c1', clientName: 'Laxmi & Sons <Pune>',
    lines: [{ serviceKey: 'GSTR3B', taxablePaise: 99_900, reimbursement: false, totalPaise: 0 }, { serviceKey: null, taxablePaise: 0, reimbursement: true, totalPaise: 5_000 }],
    cgstPaise: 8_991, sgstPaise: 8_991, igstPaise: 0, roundOffPaise: 18, totalPaise: 122_900 });
  const full = { sales: 'Professional Fees', output_cgst: 'Output CGST', output_sgst: 'Output SGST', output_igst: 'Output IGST', round_off: 'Round Off', reimbursement: 'Reimbursements', bank: 'HDFC Bank', cash: 'Cash', tds_receivable: 'TDS Receivable' };
  it('balanced sales voucher with escaped party name; debit negative', () => {
    const { xml, errors, count } = buildTallyXml('Sharma & Mehta', [inv], full);
    expect(errors).toEqual([]); expect(count).toBe(1);
    expect(xml).toContain('<SVCURRENTCOMPANY>Sharma &amp; Mehta</SVCURRENTCOMPANY>');
    expect(xml).toContain('<PARTYLEDGERNAME>Laxmi &amp; Sons &lt;Pune&gt;</PARTYLEDGERNAME>');
    expect(xml).toContain('<LEDGERNAME>Laxmi &amp; Sons &lt;Pune&gt;</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1229.00</AMOUNT>');
    expect(xml).toContain('<LEDGERNAME>Professional Fees</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>999.00</AMOUNT>');
    expect(xml).toContain('<DATE>20260930</DATE>');
  });
  it('unmapped ledgers are reported, voucher skipped; party override used', () => {
    const { errors, count } = buildTallyXml('X', [inv], { sales: 'Fees' });
    expect(count).toBe(0);
    expect(errors.map((e) => e.account)).toEqual(expect.arrayContaining(['output_cgst', 'reimbursement', 'round_off']));
    const rc = receiptVoucher({ id: 'r1', number: 'SMAR/2627/0001', date: '2026-10-01', clientId: 'c1', clientName: 'L', mode: 'upi', amountPaise: 100_000, tdsPaise: 10_000 });
    const out = buildTallyXml('X', [rc], { ...full, 'party:c1': 'Laxmi (Debtors)' });
    expect(out.errors).toEqual([]);
    expect(out.xml).toContain('<LEDGERNAME>Laxmi (Debtors)</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1100.00</AMOUNT>');
    expect(out.xml).toContain('<LEDGERNAME>HDFC Bank</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1000.00</AMOUNT>');
  });
});
