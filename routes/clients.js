const express = require("express");
const router = express.Router();
const db = require("../database");


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
login
}=req.body;


const result = await db.query(
`
INSERT INTO clients
(name,phone,login,active)
VALUES($1,$2,$3,true)
RETURNING *
`,
[name,phone,login]
);


res.json(result.rows[0]);


}catch(error){

res.status(500).json({
error:error.message
});

}

});


module.exports = router;
