// Общий модуль расчётов: работает и в браузере (window.Calc), и на сервере (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  function num(v, name, opts) {
    const { min = 0, max = 1e9, required = true, positive = false } = opts || {};
    if (v === '' || v === null || v === undefined) {
      if (required) throw new Error(`Заполните поле «${name}»`);
      return 0;
    }
    const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(n)) throw new Error(`Поле «${name}» должно быть числом`);
    if (positive && n <= 0) throw new Error(`Поле «${name}» должно быть больше нуля`);
    if (n < min) throw new Error(`Поле «${name}» не может быть меньше ${min}`);
    if (n > max) throw new Error(`Поле «${name}» слишком большое`);
    return n;
  }

  /**
   * Себестоимость и цена одной штуки.
   * input: { lengthMm, widthMm, priceMode: 'm2'|'sheet', pricePerM2, sheetPrice, sheetLengthMm, sheetWidthMm,
   *          wastePct, labor, extra, profitPct }
   * Формулы:
   *   площадь, м²      = длина × ширина / 1 000 000
   *   материал (чисто) = площадь × цена за м²   (для листа: цена листа / площадь листа)
   *   материал (всего) = чисто × (1 + отходы% / 100)
   *   себестоимость    = материал (всего) + работа + доп. расходы
   *   цена клиенту     = себестоимость × (1 + прибыль% / 100)   (наценка на себестоимость)
   */
  function calcUnit(i) {
    const lengthMm = num(i.lengthMm, 'Длина заготовки, мм', { positive: true, max: 1e6 });
    const widthMm = num(i.widthMm, 'Ширина заготовки, мм', { positive: true, max: 1e6 });
    const wastePct = num(i.wastePct, 'Отходы, %', { max: 500, required: false });
    const labor = num(i.labor, 'Стоимость работы', { required: false });
    const extra = num(i.extra, 'Дополнительные расходы', { required: false });
    const profitPct = num(i.profitPct, 'Желаемая прибыль, %', { max: 10000, required: false });

    let pricePerM2;
    if (i.priceMode === 'sheet') {
      const sheetPrice = num(i.sheetPrice, 'Цена листа', { positive: true });
      const sl = num(i.sheetLengthMm, 'Длина листа, мм', { positive: true, max: 1e6 });
      const sw = num(i.sheetWidthMm, 'Ширина листа, мм', { positive: true, max: 1e6 });
      pricePerM2 = sheetPrice / ((sl * sw) / 1e6);
    } else {
      pricePerM2 = num(i.pricePerM2, 'Цена металла за м²', { positive: true });
    }

    const areaM2 = (lengthMm * widthMm) / 1e6;
    const materialNet = areaM2 * pricePerM2;
    const materialWaste = materialNet * (wastePct / 100);
    const materialTotal = materialNet + materialWaste;
    const cost = materialTotal + labor + extra;
    const price = cost * (1 + profitPct / 100);

    return {
      areaM2: Math.round(areaM2 * 1e6) / 1e6,
      pricePerM2: r2(pricePerM2),
      materialNet: r2(materialNet),
      materialWaste: r2(materialWaste),
      materialTotal: r2(materialTotal),
      labor: r2(labor),
      extra: r2(extra),
      cost: r2(cost),
      price: r2(price),
      profit: r2(r2(price) - r2(cost)),
    };
  }

  /** Итоги заказа. */
  function calcOrder(o) {
    const qty = num(o.qty, 'Количество', { positive: true, max: 1e6 });
    if (!Number.isInteger(qty)) throw new Error('Количество должно быть целым числом');
    const unitCost = num(o.unitCost, 'Себестоимость 1 шт.');
    const unitPrice = num(o.unitPrice, 'Цена продажи 1 шт.');
    const revenue = r2(unitPrice * qty);
    const totalCost = r2(unitCost * qty);
    const profit = r2(revenue - totalCost);
    const marginPct = revenue > 0 ? r2((profit / revenue) * 100) : 0;
    return { qty, unitCost: r2(unitCost), unitPrice: r2(unitPrice), revenue, totalCost, profit, marginPct };
  }

  return { r2, num, calcUnit, calcOrder };
});
