const ctx = document.getElementById('temperatureChart');

new Chart(ctx, {
    type: 'line',
    data: {
        labels: ['1', '2', '3', '4', '5'],
        datasets: [{
            label: 'Temperature',
            data: [25, 27, 26, 30, 29],
            borderWidth: 2
        }]
    },
    options: {
        responsive: true
    }
});

var gauge = new RadialGauge({
    renderTo: 'gauge',
    width: 300,
    height: 300,
    units: "CPU Temp",
    minValue: 0,
    maxValue: 100,
    value: 65,
    majorTicks: [
        "0",
        "20",
        "40",
        "60",
        "80",
        "100"
    ],
    minorTicks: 2,
    strokeTicks: true,
    highlights: [
        {
            from: 80,
            to: 100,
            color: 'rgba(200, 50, 50, .75)'
        }
    ],
    colorPlate: "#fff",
    borderShadowWidth: 0,
    borders: true,
    needleType: "arrow",
    needleWidth: 2,
    needleCircleSize: 7,
    animationDuration: 1500
}).draw();