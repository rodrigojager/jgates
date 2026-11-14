import java.sql.Connection;
import java.sql.Statement;
import javax.persistence.EntityManager;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.parsers.SAXParserFactory;
import javax.xml.stream.XMLInputFactory;
import org.springframework.jdbc.core.JdbcTemplate;

class InjectionFixture {
    void sql(Connection conn, Statement stmt, EntityManager em, JdbcTemplate jdbc, String name) throws Exception {
        // ruleid: jgates.java.sql-string-building
        stmt.executeQuery("SELECT * FROM users WHERE name = '" + name + "'");
        // ruleid: jgates.java.sql-string-building
        stmt.executeUpdate("DELETE FROM users WHERE name = '" + name + "'");
        // ruleid: jgates.java.sql-string-building
        em.createQuery("FROM User u WHERE u.name = '" + name + "'");
        // ruleid: jgates.java.sql-string-building
        em.createNativeQuery("SELECT * FROM users WHERE name = '" + name + "'");
        // ruleid: jgates.java.sql-string-building
        jdbc.queryForList("SELECT * FROM users WHERE name = '" + name + "'");
        // ruleid: jgates.java.sql-string-building
        jdbc.update(String.format("DELETE FROM users WHERE name = '%s'", name));
        // ok: jgates.java.sql-string-building
        stmt.executeQuery("SELECT * FROM users");
        // ok: jgates.java.sql-string-building
        conn.prepareStatement("SELECT * FROM users WHERE name = ?");
        // ok: jgates.java.sql-string-building
        em.createQuery("FROM User u WHERE u.name = :name").setParameter("name", name);
        // ok: jgates.java.sql-string-building
        jdbc.queryForList("SELECT * FROM users WHERE name = ?", name);
    }

    void command(String host, String script) throws Exception {
        // ruleid: jgates.java.os-command-injection
        Runtime.getRuntime().exec("ping " + host);
        // ruleid: jgates.java.os-command-injection
        Runtime.getRuntime().exec(script);
        // ruleid: jgates.java.os-command-injection
        new ProcessBuilder("sh", "-c", "ping " + host).start();
        // ruleid: jgates.java.os-command-injection
        new ProcessBuilder(script).start();
        // ok: jgates.java.os-command-injection
        Runtime.getRuntime().exec("uptime");
        // ok: jgates.java.os-command-injection
        new ProcessBuilder("ls", "-l", host).start();
        // ok: jgates.java.os-command-injection
        new ProcessBuilder("sh", "-c", "uptime").start();
    }

    void xml() throws Exception {
        // ruleid: jgates.java.xml-external-entity
        DocumentBuilderFactory unsafeDom = DocumentBuilderFactory.newInstance();
        unsafeDom.newDocumentBuilder();
        // ruleid: jgates.java.xml-external-entity
        SAXParserFactory unsafeSax = SAXParserFactory.newInstance();
        unsafeSax.newSAXParser();
        // ruleid: jgates.java.xml-external-entity
        XMLInputFactory unsafeStax = XMLInputFactory.newInstance();
        unsafeStax.createXMLStreamReader(System.in);
    }

    void xmlSafeDom() throws Exception {
        // ok: jgates.java.xml-external-entity
        DocumentBuilderFactory dom = DocumentBuilderFactory.newInstance();
        dom.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        dom.newDocumentBuilder();
    }

    void xmlSafeSax() throws Exception {
        // ok: jgates.java.xml-external-entity
        SAXParserFactory sax = SAXParserFactory.newInstance();
        sax.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        sax.newSAXParser();
    }

    void xmlSafeStax() throws Exception {
        // ok: jgates.java.xml-external-entity
        XMLInputFactory stax = XMLInputFactory.newInstance();
        stax.setProperty(XMLInputFactory.SUPPORT_DTD, false);
        stax.createXMLStreamReader(System.in);
    }
}
