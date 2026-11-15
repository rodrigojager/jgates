// Fixture of java-signals.yaml: one match and one non-match per rule. Never compiled or run.
package signals;

// ruleid: jgates.java.uses-graphql
import graphql.schema.GraphQLSchema;
// ruleid: jgates.java.uses-graphql
import com.netflix.graphql.dgs.*;
// ruleid: jgates.java.uses-graphql
import static graphql.Scalars.GraphQLString;
// ok: jgates.java.uses-graphql
import com.example.graphqlnotes.Notes;

// ruleid: jgates.java.uses-websocket
import javax.websocket.Session;
// ruleid: jgates.java.uses-websocket
import org.springframework.web.socket.WebSocketHandler;
// ok: jgates.java.uses-websocket
import com.example.websocketnotes.Notes;

// ruleid: jgates.java.uses-webrtc
import org.webrtc.PeerConnection;
// ruleid: jgates.java.uses-webrtc
import dev.onvoid.webrtc.RTCConfiguration;
// ok: jgates.java.uses-webrtc
import com.example.webrtcnotes.Notes;

// ruleid: jgates.java.uses-oauth-client
import org.springframework.security.oauth2.client.registration.ClientRegistration;
// ruleid: jgates.java.uses-oauth-client
import com.nimbusds.oauth2.sdk.AuthorizationCodeGrant;
// ok: jgates.java.uses-oauth-client
import com.example.oauthnotes.Notes;

// ruleid: jgates.java.uses-oauth-authorization-server
import org.springframework.security.oauth2.server.authorization.client.RegisteredClient;
// ruleid: jgates.java.uses-oauth-authorization-server
import org.apache.oltu.oauth2.as.issuer.MD5Generator;
// ok: jgates.java.uses-oauth-authorization-server
import com.example.authserver.Notes;

// ruleid: jgates.java.uses-jwt
import io.jsonwebtoken.Jwts;
// ruleid: jgates.java.uses-jwt
import com.auth0.jwt.JWT;
// ok: jgates.java.uses-jwt
import com.example.jwtnotes.Notes;

// ruleid: jgates.java.uses-saml
import org.opensaml.saml.saml2.core.Assertion;
// ruleid: jgates.java.uses-saml
import com.onelogin.saml2.Auth;
// ok: jgates.java.uses-saml
import com.example.samlnotes.Notes;

// ruleid: jgates.java.uses-totp
import dev.samstevens.totp.code.CodeVerifier;
// ruleid: jgates.java.uses-totp
import com.warrenstrange.googleauth.GoogleAuthenticator;
// ok: jgates.java.uses-totp
import com.example.totpnotes.Notes;

// ruleid: jgates.java.uses-ldap
import javax.naming.ldap.InitialLdapContext;
// ruleid: jgates.java.uses-ldap
import org.springframework.ldap.core.LdapTemplate;
// ok: jgates.java.uses-ldap
import com.example.ldapnotes.Notes;

// ruleid: jgates.java.uses-xml
import javax.xml.parsers.DocumentBuilderFactory;
// ruleid: jgates.java.uses-xml
import org.dom4j.io.SAXReader;
// ok: jgates.java.uses-xml
import com.example.xmlnotes.Notes;

// ruleid: jgates.java.uses-memcache
import net.spy.memcached.MemcachedClient;
// ruleid: jgates.java.uses-memcache
import net.rubyeye.xmemcached.XMemcachedClient;
// ok: jgates.java.uses-memcache
import com.example.memcachenotes.Notes;

// ruleid: jgates.java.uses-mail
import javax.mail.Transport;
// ruleid: jgates.java.uses-mail
import org.springframework.mail.javamail.JavaMailSender;
// ok: jgates.java.uses-mail
import com.example.mailnotes.Notes;

// ruleid: jgates.java.uses-templates
import org.thymeleaf.TemplateEngine;
// ruleid: jgates.java.uses-templates
import freemarker.template.Configuration;
// ok: jgates.java.uses-templates
import com.example.templatenotes.Notes;

// ruleid: jgates.java.uses-file-upload
import org.springframework.web.multipart.MultipartFile;
// ruleid: jgates.java.uses-file-upload
import org.apache.commons.fileupload.servlet.ServletFileUpload;
// ok: jgates.java.uses-file-upload
import com.example.uploadnotes.Notes;

// ruleid: jgates.java.uses-archives
import java.util.zip.ZipInputStream;
// ruleid: jgates.java.uses-archives
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
// ok: jgates.java.uses-archives
import java.util.List;

// ruleid: jgates.java.uses-browser-dom
import com.google.gwt.dom.client.Document;
// ruleid: jgates.java.uses-browser-dom
import elemental2.dom.DomGlobal;
// ok: jgates.java.uses-browser-dom
import com.example.domnotes.Notes;

class Calls {
    void run(javax.servlet.http.HttpServletRequest request, java.nio.file.Path p) throws Exception {
        // ruleid: jgates.java.uses-file-upload
        request.getParts();
        // ok: jgates.java.uses-file-upload
        request.getParameter("name");
        // ruleid: jgates.java.uses-archives
        java.nio.file.FileSystems.newFileSystem(p);
        // ok: jgates.java.uses-archives
        java.nio.file.Files.readAllBytes(p);
        // The words "import org.webrtc.PeerConnection" only appear in this comment and in the string below.
        String text = "import io.jsonwebtoken.Jwts;";
    }
}
