export function getPricing(service, data) {
  let total = 0;
  let breakdown = [];

  if (service === "carpet") {
    const { rooms = 0, stairs = 0 } = data;
    const roomPrice = 50;
    const stairPrice = 50;
    const min = 150;

    total = rooms * roomPrice + stairs * stairPrice;
    if (total < min) total = min;

    breakdown.push(`${rooms} rooms`, `${stairs} stairs`);
  }

  if (service === "upholstery") {
    let items = data.items || [];
    let itemTotal = 0;

    for (const item of items) {
      if (item.type === "sectional") {
        let price = item.cushions * 50;
        if (price < 250) price = 250;
        itemTotal += price;
      } else if (item.type === "recliner") {
        itemTotal += 85;
      }
    }

    total = itemTotal;
    breakdown = items.map(i => `${i.type}(${i.cushions || 1})`);
  }

  if (service === "duct") {
    const { basic = 0, deep = 0, furnace = 0, dryerFeet = 0 } = data;

    const basicPrice = 200;
    const deepPrice = 500;
    const furnacePrice = 200;
    const dryerBase = 200;
    const dryerExtraPerFoot = 10;
    const dryerFreeFeet = 8;

    total =
      basic * basicPrice +
      deep * deepPrice +
      furnace * furnacePrice;

    if (dryerFeet > 0) {
      const extraFeet = Math.max(0, dryerFeet - dryerFreeFeet);
      total += dryerBase + extraFeet * dryerExtraPerFoot;
      breakdown.push(`Dryer vent: ${dryerFeet}ft`);
    }

    if (basic) breakdown.push(`${basic} basic`);
    if (deep) breakdown.push(`${deep} deep`);
    if (furnace) breakdown.push(`${furnace} furnace`);
  }

  return {
    total,
    breakdown: breakdown.join(", ")
  };
}