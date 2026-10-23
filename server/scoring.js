function calculatePoints(count) {
    if (count === 1) return 3;
    if (count === 2) return 7;
    return 0;
}

function computeTotalScore(counts) {
    return counts.reduce((total, count) => total + calculatePoints(count), 0);
}

module.exports = { calculatePoints, computeTotalScore };
