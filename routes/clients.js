const express = require("express");
const router = express.Router();
const db = require("../database");

router.get("/", async (req,res)=>{

try{

const result = await db.query(
"SELECT * FROM clients ORDER BY id"
);

res.json(result.rows);

}catch(error){

res.status(500).json({
error:error.message
});

}

});

module.exports = router;
