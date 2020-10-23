const time = document.querySelector('.time'),
  greeting = document.querySelector('.greeting'),
  name = document.querySelector('.name'),
  focus = document.querySelector('.focus');
  let week = document.querySelector('.weektime');
  week = new Date();
  let weekday = new Array(7);
  weekday[0] = "воскресенье";
  weekday[1] = "понедельник";
  weekday[2] = "вторник";
  weekday[3] = "среду";
  weekday[4] = "четверг";
  weekday[5] = "пятницу";
  weekday[6] = "субботу";
  document.write("Ты проверяешь работу в " + weekday[week.getDay()]);

const showAmPm = true;

function showTime() {
  let today = new Date(),
    hour = today.getHours(),
    min = today.getMinutes(),
    sec = today.getSeconds();
    
  const amPm = hour >= 12 ? 'PM' : 'AM';

  hour = hour % 12 || 12;

  time.innerHTML = `${hour}<span>:</span>${addZero(min)}<span>:</span>${addZero(
    sec
  )} ${showAmPm ? amPm : ''}`;

  setTimeout(showTime, 1000);
}

function addZero(n) {
  return (parseInt(n, 10) < 10 ? '0' : '') + n;
}

function setBgGreet() {
  let today = new Date(),
    hour = today.getHours();

  if ((6 < hour) & (hour < 12)) {
    document.body.style.backgroundImage =
      "url('https://cs4.pikabu.ru/post_img/big/2016/07/22/8/1469193312164236771.jpg')";
    greeting.textContent = 'Доброе утро, ';
  } else if ((12 <= hour) & (hour < 18)) {
    document.body.style.backgroundImage =
      "url('https://i.pinimg.com/originals/c6/67/b2/c667b27d1f8f4b97cdcde67a4f0b984c.jpg')";
    greeting.textContent = 'Доброго дня, ';
  } else if ((18 <= hour) & (hour <= 24)) {
    document.body.style.backgroundImage =
      "url('https://i.pinimg.com/originals/13/d0/9b/13d09b8948e08a6def66ad89c76fded0.jpg')";
    greeting.textContent = 'Доброго вечера, ';
  } else {
    document.body.style.backgroundImage =
      "url('https://i.ibb.co/924T2Wv/night.jpg')";
    greeting.textContent = 'Доброй ночи, ';
    document.body.style.color = 'white';
  }
}

function getName() {
  if (localStorage.getItem('name') === null) {
    name.textContent = '-> Ваше имя <-';
  } else {
    name.textContent = localStorage.getItem('name');
  }
}

function setName(e) {
  if (e.type === 'keypress') {
  
    if (e.which == 13 || e.keyCode == 13) {
      localStorage.setItem('name', e.target.innerText);
      name.blur();
    }
  } else {
    localStorage.setItem('name', e.target.innerText);
  }
}

function getFocus() {
  if (localStorage.getItem('focus') === null) {
    focus.textContent = '-> Напиши уже что-нибудь... <-';
  } else {
    focus.textContent = localStorage.getItem('focus');
  }
}

function setFocus(e) {
  if (e.type === 'keypress') {
  
    if (e.which == 13 || e.keyCode == 13) {
      localStorage.setItem('focus', e.target.innerText);
      focus.blur();
    }
  } else {
    localStorage.setItem('focus', e.target.innerText);
  }
}


const weatherIcon = document.querySelector('.weather-icon');
const temperature = document.querySelector('.temperature');
const weatherDescription = document.querySelector('.weather-description');
const city = document.querySelector('.city');

async function getWeather() {
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${city.textContent}&lang=ru&appid=1ec345fa61b39b1930050e1f61616b01&units=metric`;
  const res = await fetch(url);
  const data = await res.json();
  
  weatherIcon.className = 'weather-icon owf';
  weatherIcon.classList.add(`owf-${data.weather[0].id}`);
  temperature.textContent = `${data.main.temp.toFixed(0)}°C`;
  weatherDescription.textContent = data.weather[0].description;
}

function setCity(event) {
  if (event.code === 'Enter') {
    getWeather();
    city.blur();
  }
}

document.addEventListener('DOMContentLoaded', getWeather);
city.addEventListener('keypress', setCity);


name.addEventListener('keypress', setName);
name.addEventListener('blur', setName);
focus.addEventListener('keypress', setFocus);
focus.addEventListener('blur', setFocus);

showTime();
setBgGreet();
getName();
getFocus();