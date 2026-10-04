// Draws the charts with Chart.js. The data comes as JSON in a data-chart attribute.
(function () {
  'use strict';

  if (typeof Chart === 'undefined') return;

  const styles = getComputedStyle(document.documentElement);
  const cssVar = (name) => styles.getPropertyValue(name).trim();
  const COLORS = {
    up: cssVar('--up') || '#15803d',
    down: cssVar('--down') || '#b42318',
    target: '#2563eb',
    grid: cssVar('--border') || '#d9e0e6',
    text: cssVar('--muted') || '#5b6770',
  };

  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

  function lineColor(config) {
    return config.isUp ? COLORS.up : COLORS.down;
  }

  function withAlpha(hex, alpha) {
    const value = hex.replace('#', '');
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function drawSparkline(canvas, config) {
    new Chart(canvas, {
      type: 'line',
      data: {
        labels: config.prices.map(function (_, index) { return index; }),
        datasets: [{
          data: config.prices,
          borderColor: lineColor(config),
          borderWidth: 1.5,
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0.25,
          fill: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        events: [],
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } },
      },
    });
  }

  function drawPriceChart(canvas, config) {
    const color = lineColor(config);
    const datasets = [{
      label: 'Close',
      data: config.prices,
      borderColor: color,
      backgroundColor: withAlpha(color, 0.1),
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 5,
      tension: 0.2,
      fill: true,
      order: 2,
    }];

    // target prices as horizontal lines
    config.lines.forEach(function (line) {
      datasets.push({
        label: line.label + ': ' + usd.format(line.value),
        data: config.labels.map(function () { return line.value; }),
        borderColor: COLORS[line.kind] || COLORS.target,
        borderWidth: 1.5,
        borderDash: [6, 4],
        pointRadius: 0,
        pointHoverRadius: 0,
        fill: false,
        order: 1,
      });
    });

    new Chart(canvas, {
      type: 'line',
      data: { labels: config.labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: config.lines.length > 0,
            position: 'bottom',
            labels: { usePointStyle: true, boxWidth: 8, color: COLORS.text },
          },
          tooltip: {
            callbacks: {
              label: function (context) {
                return context.datasetIndex === 0
                  ? 'Close: ' + usd.format(context.parsed.y)
                  : context.dataset.label;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { maxTicksLimit: 6, maxRotation: 0, color: COLORS.text },
          },
          y: {
            grid: { color: COLORS.grid },
            ticks: {
              color: COLORS.text,
              callback: function (value) { return usd.format(value); },
            },
          },
        },
      },
    });
  }

  document.querySelectorAll('canvas[data-chart]').forEach(function (canvas) {
    let config;
    try {
      // JSON.parse only, nothing is evaluated
      config = JSON.parse(canvas.dataset.chart);
    } catch (error) {
      return;
    }
    if (config.type === 'spark') drawSparkline(canvas, config);
    else if (config.type === 'full') drawPriceChart(canvas, config);
  });
})();
