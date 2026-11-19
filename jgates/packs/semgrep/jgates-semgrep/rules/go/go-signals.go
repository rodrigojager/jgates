// Fixture of go-signals.yaml: one match and one non-match per rule. Never compiled or run.
package signals

// ruleid: jgates.go.uses-graphql
import "github.com/99designs/gqlgen/graphql"

// ruleid: jgates.go.uses-graphql
import gql "github.com/graph-gophers/graphql-go"

// ok: jgates.go.uses-graphql
import "github.com/example/graphql-notes"

// ruleid: jgates.go.uses-websocket
import "github.com/gorilla/websocket"

// ruleid: jgates.go.uses-websocket
import ws "nhooyr.io/websocket"

// ok: jgates.go.uses-websocket
import "github.com/example/websocket-notes"

// ruleid: jgates.go.uses-webrtc
import "github.com/pion/webrtc/v3"

// ruleid: jgates.go.uses-webrtc
import "github.com/pion/interceptor"

// ok: jgates.go.uses-webrtc
import "github.com/example/webrtc-notes"

// ruleid: jgates.go.uses-oauth-client
import "golang.org/x/oauth2"

// ruleid: jgates.go.uses-oauth-client
import oidc "github.com/coreos/go-oidc/v3/oidc"

// ok: jgates.go.uses-oauth-client
import "golang.org/x/oauth3notes"

// ruleid: jgates.go.uses-oauth-authorization-server
import "github.com/ory/fosite"

// ruleid: jgates.go.uses-oauth-authorization-server
import "github.com/go-oauth2/oauth2/v4/server"

// ok: jgates.go.uses-oauth-authorization-server
import "github.com/example/fosite-notes"

// ruleid: jgates.go.uses-jwt
import "github.com/golang-jwt/jwt/v5"

// ruleid: jgates.go.uses-jwt
import jose "github.com/go-jose/go-jose/v3"

// ok: jgates.go.uses-jwt
import "github.com/example/jwt-notes"

// ruleid: jgates.go.uses-saml
import "github.com/crewjam/saml/samlsp"

// ruleid: jgates.go.uses-saml
import saml2 "github.com/russellhaering/gosaml2"

// ok: jgates.go.uses-saml
import "github.com/example/saml-notes"

// ruleid: jgates.go.uses-totp
import "github.com/pquerna/otp/totp"

// ruleid: jgates.go.uses-totp
import "github.com/xlzd/gotp"

// ok: jgates.go.uses-totp
import "github.com/example/otp-notes"

// ruleid: jgates.go.uses-ldap
import "github.com/go-ldap/ldap/v3"

// ruleid: jgates.go.uses-ldap
import ldapv3 "gopkg.in/ldap.v3"

// ok: jgates.go.uses-ldap
import "github.com/example/ldap-notes"

// ruleid: jgates.go.uses-xml
import "encoding/xml"

// ruleid: jgates.go.uses-xml
import "github.com/beevik/etree"

// ok: jgates.go.uses-xml
import "encoding/xmlnotes"

// ruleid: jgates.go.uses-memcache
import "github.com/bradfitz/gomemcache/memcache"

// ruleid: jgates.go.uses-memcache
import "github.com/rainycape/memcache"

// ok: jgates.go.uses-memcache
import "github.com/example/memcache-notes"

// ruleid: jgates.go.uses-mail
import "net/smtp"

// ruleid: jgates.go.uses-mail
import gomail "gopkg.in/gomail.v2"

// ok: jgates.go.uses-mail
import "net/smtpnotes"

// ruleid: jgates.go.uses-templates
import "html/template"

// ruleid: jgates.go.uses-templates
import "github.com/flosch/pongo2/v6"

// ok: jgates.go.uses-templates
import "html/templatenotes"

// ruleid: jgates.go.uses-file-upload
import "mime/multipart"

// ok: jgates.go.uses-file-upload
import "mime/multipartnotes"

// ruleid: jgates.go.uses-archives
import "archive/zip"

// ruleid: jgates.go.uses-archives
import "compress/gzip"

// ok: jgates.go.uses-archives
import "archive/zipnotes"

// ruleid: jgates.go.uses-browser-dom
import "syscall/js"

// ruleid: jgates.go.uses-browser-dom
import "github.com/hexops/vecty"

// ok: jgates.go.uses-browser-dom
import "syscall/jsnotes"

func uploads(r *Request, c *Context) {
	// ruleid: jgates.go.uses-file-upload
	file, header, err := r.FormFile("avatar")
	// ruleid: jgates.go.uses-file-upload
	err = r.ParseMultipartForm(32 << 20)
	// ruleid: jgates.go.uses-file-upload
	err = c.SaveUploadedFile(file, "/tmp/x")
	// ok: jgates.go.uses-file-upload
	name := r.FormValue("name")
}

// ok: jgates.go.uses-graphql
var NoteGraphQL = "import \"github.com/99designs/gqlgen/graphql\" is only mentioned here"

// ok: jgates.go.uses-websocket
var NoteWS = "github.com/gorilla/websocket" // not an import
