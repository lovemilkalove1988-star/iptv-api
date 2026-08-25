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


// Проверка авторизации
function auth(req,res,next){

  if(req.session.user){
    next();
  }else{
    res.redirect("/login");
  }

}


// LOGIN страница
app.get("/login",(req,res)=>{

res.send(`
<html>
<body style="background:#111;color:white;font-family:Arial;padding:30px">

<h2>🔐 IPTV Admin Login</h2>

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
app.post("/login",async(req,res)=>{

try{

const {username,password}=req.body;


const result = await db.query(
"SELECT * FROM users WHERE username=$1 AND password=$2",
[username,password]
);


if(result.rows.length===0){

return res.send("Неверный логин или пароль");

}


req.session.user=result.rows[0];


res.redirect("/admin");


}catch(error){

res.status(500).send(error.message);

}

});



// Админка
app.get("/admin",auth,(req,res)=>{

res.sendFile(__dirname+"/public/admin/index.html");

});



// Выход
app.get("/logout",(req,res)=>{

req.session.destroy();

res.redirect("/login");

});



// Главная
app.get("/",(req,res)=>{

res.json({
status:"online",
message:"IPTV API is working"
});

});



// Тест API
app.get("/api/test",(req,res)=>{

res.json({
message:"API connection successful"
});

});



// Проверка базы
app.get("/api/db-test",async(req,res)=>{

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



// Каналы
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



// HTML список каналов
app.get("/channels",async(req,res)=>{

try{

const result=await db.query(
"SELECT * FROM channels ORDER BY id"
);


let html=`

<html>

<head>

<title>IPTV Channels</title>

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

<h1>📺 IPTV Channels</h1>

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
"SELECT category,COUNT(*) FROM channels GROUP BY category ORDER BY category"
);


res.json(result.rows);


}catch(error){

res.status(500).json({
error:error.message
});

}

});


// Админка - каналы
app.get("/admin/channels", auth, async (req,res)=>{

try{

const result = await db.query(
"SELECT * FROM channels ORDER BY id DESC"
);

let html = `
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Каналы</title>

<style>
body{
background:#111;
color:white;
font-family:Arial;
padding:20px;
}

input,button{
width:100%;
padding:12px;
margin:5px 0;
border-radius:8px;
border:none;
}

button{
background:#333;
color:white;
}

.card{
background:#222;
padding:15px;
margin:10px 0;
border-radius:12px;
}

a{
color:white;
text-decoration:none;
}
</style>

</head>

<body>

<h2>📺 Управление каналами</h2>


<form method="POST" action="/admin/channels/add">

<input name="name" placeholder="Название канала">

<input name="url" placeholder="URL потока">

<input name="category" placeholder="Категория">

<button>➕ Добавить</button>

</form>

<hr>
`;

result.rows.forEach(ch=>{

html += `

<div class="card">

<b>${ch.name}</b>
<br>
${ch.category || "Без категории"}
<br>
<small>${ch.url}</small>

<form method="POST" action="/admin/channels/delete">

<input type="hidden" name="id" value="${ch.id}">

<button>🗑 Удалить</button>

</form>

</div>

`;

});


html += `

<a href="/admin">⬅ Назад</a>

</body>
</html>
`;

res.send(html);


}catch(error){

res.status(500).send(error.message);

}

});


// Добавление канала
app.post("/admin/channels/add", auth, async(req,res)=>{

try{

const {name,url,category}=req.body;

await db.query(
"INSERT INTO channels(name,url,category) VALUES($1,$2,$3)",
[name,url,category]
);

res.redirect("/admin/channels");


}catch(error){

res.status(500).send(error.message);

}

});


// Удаление канала
app.post("/admin/channels/delete", auth, async(req,res)=>{

try{

await db.query(
"DELETE FROM channels WHERE id=$1",
[req.body.id]
);

res.redirect("/admin/channels");


}catch(error){

res.status(500).send(error.message);

}

});

app.listen(PORT,()=>{

console.log(`IPTV API running on port ${PORT}`);

});
