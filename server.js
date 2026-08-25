const express = require("express");
const cors = require("cors");
const session = require("express-session");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: "iptv-secret-2026",
  resave: false,
  saveUninitialized: false
}));

app.use(express.static("public"));


// Проверка входа
function auth(req, res, next) {
  if (req.session.user) {
    next();
  } else {
    res.redirect("/login");
  }
}


// Страница входа
app.get("/login", (req, res) => {
  res.send(`
  <html>
  <body style="background:#111;color:white;font-family:Arial;padding:30px">
  <h2>IPTV Admin Login</h2>

  <form method="POST" action="/login">
    <input name="username" placeholder="Логин"><br><br>
    <input name="password" type="password" placeholder="Пароль"><br><br>
    <button>Войти</button>
  </form>

  </body>
  </html>
  `);
});


// Авторизация
app.post("/login", async (req,res)=>{

  try {

    const {username,password}=req.body;

    const result = await db.query(
      "SELECT * FROM users WHERE username=$1 AND password=$2",
      [username,password]
    );


    if(result.rows.length){

      req.session.user=result.rows[0];

      res.redirect("/admin");

    } else {

      res.send("Неверный логин или пароль");

    }


  } catch(error){

    res.status(500).send(error.message);

  }

});


// Админка
app.get("/admin", auth, (req,res)=>{
  res.sendFile(__dirname + "/public/admin/index.html");
});


// Выход
app.get("/logout",(req,res)=>{

  req.session.destroy();

  res.redirect("/login");

});


// Главная
app.get("/", (req,res)=>{

  res.json({
    status:"online",
    message:"IPTV API is working"
  });

});


// Тест
app.get("/api/test",(req,res)=>{

  res.json({
    message:"API connection successful"
  });

});


// Проверка БД
app.get("/api/db-test", async(req,res)=>{

try{

const result=await db.query("SELECT NOW()");

res.json({
database:"connected",
time:result.rows[0]
});


}catch(error){

res.status(500).json({
error:error.message
});

}

});


// Клиенты
app.get("/api/setup-clients", async(req,res)=>{

try{

await db.query(`
CREATE TABLE IF NOT EXISTS clients (
id SERIAL PRIMARY KEY,
name VARCHAR(100) NOT NULL,
phone VARCHAR(30),
email VARCHAR(100),
status VARCHAR(20) DEFAULT 'active',
device_limit INTEGER DEFAULT 4,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
`);

res.json({
status:"clients table created"
});


}catch(error){

res.status(500).json({
error:error.message
});

}

});


// Каналы API
app.get("/api/channels",async(req,res)=>{

try{

const result=await db.query(
"SELECT * FROM channels ORDER BY id"
);

res.json(result.rows);


}catch(error){

res.status(500).json({
error:error.message
});

}

});


// Каналы HTML
app.get("/channels",async(req,res)=>{

try{

const result=await db.query(
"SELECT * FROM channels ORDER BY id"
);


let html=`
<html>
<head>
<title>IPTV</title>
<style>

body{
background:#111;
color:white;
font-family:Arial;
padding:20px;
}

.channel{
background:#222;
padding:15px;
margin:10px;
border-radius:10px;
}

</style>
</head>

<body>

<h1>IPTV Channels</h1>
`;


result.rows.forEach(ch=>{

html+=`

<div class="channel">

<h2>${ch.name}</h2>

<p>${ch.category || ""}</p>

<video controls width="400">

<source src="${ch.url}" type="application/x-mpegURL">

</video>

</div>

`;

});


html+="</body></html>";


res.send(html);


}catch(error){

res.status(500).send(error.message);

}

});


// Категории
app.get("/api/categories",async(req,res)=>{

try{

const result=await db.query(
"SELECT category, COUNT(*) FROM channels GROUP BY category ORDER BY category"
);

res.json(result.rows);


}catch(error){

res.status(500).json({
error:error.message
});

}

});



app.listen(PORT,()=>{

console.log(`IPTV API running on port ${PORT}`);

});
