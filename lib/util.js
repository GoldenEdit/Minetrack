// A failed ping has no response, which is stored and sent as null
function getPlayerCountOrNull (resp) {
  return resp ? resp.players.online : null
}

module.exports = {
  getPlayerCountOrNull
}
