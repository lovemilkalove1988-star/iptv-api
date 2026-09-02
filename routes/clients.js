const express = require("express");
const router = express.Router();
const db = require("../database");
const { hashPassword } = require("../password-utils");


// Список клиентов
router.get("/", async(req,res)=>{

try{

const result = await db.query(
"SELECT id,name,phone,login,active,created_at FROM clients ORDER BY id DESC"
);

res.json(result.rows);

}catch(error){

res.status(500).json({
error:error.message
});

}

});


// Добавить клиента
router.post("/", async(req,res)=>{

try{

const {
name,
phone,
login,
password
}=req.body;

if (typeof password !== "string" || password.length === 0) {
  return res.status(400).json({ error: "password is required" });
}


const result = await db.query(
`
INSERT INTO clients
(name,phone,login,password,active)
VALUES($1,$2,$3,$4,true)
RETURNING *
`,
[name,phone,login,hashPassword(password)]
);


res.json(result.rows[0]);


}catch(error){

res.status(500).json({
error:error.message
});

}

});


module.exports = router;
