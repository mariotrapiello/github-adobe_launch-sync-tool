//==== START TRANSFORM CODE - DO NOT REMOVE ====
function (event) {
//==== END TRANSFORM CODE ====
return {
  ECID:[
    {
      id: _satellite.getVar("ECID"),
      authenticatedState: "ambiguous",
      primary: false
    }
  ],
  GPM:[
    {
      id: _satellite.getVar("Profile Id"),
      authenticatedState: "ambiguous",
      primary: false
    }
  ]
}
//==== START TRANSFORM CODE - DO NOT REMOVE ====
}
//==== END TRANSFORM CODE ====