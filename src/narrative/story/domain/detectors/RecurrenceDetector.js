class RecurrenceDetector {
  detect({ signals = [] } = {}) {
    const counts = new Map();
    for (const signal of signals) counts.set(signal.type, (counts.get(signal.type) || 0) + 1);
    const recurring = [...counts.entries()].filter(([, count]) => count >= 2);
    const score = Math.min(1, recurring.reduce((sum, [, count]) => sum + count, 0) * 0.08);
    return {
      detector: 'RecurrenceDetector',
      detected: recurring.length > 0,
      score,
      markers: recurring.map(([type, count]) => `${type}:${count}`),
      reason: recurring.length ? 'Há sinais narrativos recorrentes entre memórias.' : 'Sem recorrência suficiente.',
    };
  }
}
module.exports = { RecurrenceDetector };
